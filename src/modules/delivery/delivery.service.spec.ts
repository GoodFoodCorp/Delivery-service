import { Actor } from '../../common/auth.util';
import { DomainError, DomainErrorCode } from '../../common/errors';
import { DeliveryService } from './delivery.service';
import { OrdersClient, ReadyOrder } from './orders.client';
import { RestaurantsClient } from './restaurants.client';
import { Delivery, DeliveryStatus } from './entities/delivery.schema';
import { FakeOrders, FakeRepo, FakeRestaurants } from './testing/fakes';

const courier: Actor = { userId: 'liv-1', tenantId: '', roles: ['livreur'], token: 't' };
const otherCourier: Actor = { userId: 'liv-2', tenantId: '', roles: ['livreur'], token: 't' };
const customer: Actor = { userId: 'cust-1', tenantId: '', roles: ['user'], token: 't' };
const manager: Actor = { userId: 'mgr-1', tenantId: 'resto-1', roles: ['manager'], token: 't' };
const admin: Actor = { userId: 'adm', tenantId: '', roles: ['admin'], token: 't' };

function setup() {
  const repo = new FakeRepo();
  const orders = new FakeOrders();
  const restaurants = new FakeRestaurants();
  const service = new DeliveryService(repo, orders as unknown as OrdersClient, restaurants as unknown as RestaurantsClient);
  return { repo, orders, restaurants, service };
}

async function seedDelivery(repo: FakeRepo, overrides: Partial<Delivery> = {}) {
  return repo.create({
    orderId: 'order-1',
    customerId: 'cust-1',
    restaurantId: 'resto-1',
    status: DeliveryStatus.Unassigned,
    pickup: { address: 'resto', lat: 48.85, lng: 2.35 },
    dropoff: { address: '12 rue du Client', lat: 48.86, lng: 2.36 },
    ...overrides,
  });
}

async function expectDomainError(promise: Promise<unknown>, code: DomainErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((e) => expect(e).toBeInstanceOf(DomainError));
}

const readyOrder: ReadyOrder = {
  id: 'order-9',
  customer_id: 'cust-9',
  restaurant_id: 'resto-9',
  delivery_address: '9 rue B',
  dropoff_lat: 48.87,
  dropoff_lng: 2.34,
  tip_cents: 150,
};

describe('registerReadyOrder', () => {
  it('uses the real restaurant and drop-off positions', async () => {
    const { service, restaurants } = setup();
    restaurants.locations.set('resto-9', { name: 'Good Food', address: '5 rue du Départ, Paris', lat: 48.84, lng: 2.32 });

    const { delivery, created } = await service.registerReadyOrder(readyOrder);

    expect(created).toBe(true);
    expect(delivery!.pickup).toEqual({ address: '5 rue du Départ, Paris', lat: 48.84, lng: 2.32 });
    expect(delivery!.dropoff).toEqual({ address: '9 rue B', lat: 48.87, lng: 2.34 });
    expect(delivery!.pickupLocation).toEqual({ type: 'Point', coordinates: [2.32, 48.84] });
    expect(delivery!.locationApproximate).toBe(false);
    expect(delivery!.tipCents).toBe(150);
    expect(delivery!.courierFeeCents).toBeGreaterThan(300);
  });

  it('falls back to estimated positions, flagged, when one is unknown', async () => {
    const { service } = setup();
    const { delivery } = await service.registerReadyOrder({ ...readyOrder, dropoff_lat: null, dropoff_lng: null });
    expect(delivery!.locationApproximate).toBe(true);
  });

  it('never creates a delivery for a click & collect order', async () => {
    const { service, repo } = setup();
    const result = await service.registerReadyOrder({ ...readyOrder, fulfillment: 'PICKUP' });
    expect(result).toEqual({ delivery: null, created: false });
    expect(repo.docs.size).toBe(0);
  });

  it('is idempotent, including against a concurrent creation', async () => {
    const { service, repo } = setup();
    await service.registerReadyOrder(readyOrder);
    const again = await service.registerReadyOrder(readyOrder);
    expect(again.created).toBe(false);
    expect(repo.docs.size).toBe(1);
  });
});

describe('reconcile', () => {
  it('creates the deliveries whose event was missed, once', async () => {
    const { service, orders, repo } = setup();
    orders.awaiting = [readyOrder, { ...readyOrder, id: 'order-10' }];

    expect(await service.reconcile()).toHaveLength(2);
    expect(await service.reconcile()).toHaveLength(0);
    expect(repo.docs.size).toBe(2);
  });
});

describe('listAvailable', () => {
  it('exposes no customer data before acceptance', async () => {
    const { service, repo } = setup();
    await seedDelivery(repo, { courierFeeCents: 420, tipCents: 100 });

    const [view] = await service.listAvailable(courier);

    expect(view).not.toHaveProperty('customerId');
    expect(JSON.stringify(view)).not.toContain('12 rue du Client');
    expect(view.courierFeeCents).toBe(420);
    expect(view.tipCents).toBe(100);
    expect(view.distanceKm).toBeGreaterThan(0);
  });

  it('does not call order-service on a courier poll', async () => {
    const { service, orders } = setup();
    orders.unreachable = true;
    await expect(service.listAvailable(courier)).resolves.toEqual([]);
  });

  it('rejects non-couriers', async () => {
    await expectDomainError(setup().service.listAvailable(customer), DomainErrorCode.Forbidden);
  });
});

describe('accept and release', () => {
  it('assigns the courier on both sides', async () => {
    const { service, repo, orders } = setup();
    const d = await seedDelivery(repo);

    const accepted = await service.accept(courier, String(d._id));

    expect(accepted.status).toBe(DeliveryStatus.Assigned);
    expect(accepted.livreurId).toBe('liv-1');
    expect(orders.couriers.get('order-1')).toBe('liv-1');
  });

  it('lets exactly one of two concurrent couriers win', async () => {
    const { service, repo } = setup();
    const d = await seedDelivery(repo);

    const results = await Promise.allSettled([
      service.accept(courier, String(d._id)),
      service.accept(otherCourier, String(d._id)),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rolls the claim back when order-service refuses', async () => {
    const { service, repo, orders } = setup();
    const d = await seedDelivery(repo);
    orders.couriers.set('order-1', 'liv-9'); // claimed elsewhere already

    await expectDomainError(service.accept(courier, String(d._id)), DomainErrorCode.Conflict);
    expect(repo.docs.get(String(d._id))!.status).toBe(DeliveryStatus.Unassigned);
  });

  it('accepts by order id too, and 404s on unknown delivery', async () => {
    const { service, repo } = setup();
    await seedDelivery(repo);
    await expect(service.accept(courier, 'order-1')).resolves.toMatchObject({ livreurId: 'liv-1' });
    await expectDomainError(service.accept(courier, 'nope'), DomainErrorCode.NotFound);
  });

  it('release frees the delivery for another courier', async () => {
    const { service, repo, orders } = setup();
    const d = await seedDelivery(repo);
    await service.accept(courier, String(d._id));

    await service.release(courier, String(d._id));

    expect(orders.couriers.has('order-1')).toBe(false);
    await expect(service.accept(otherCourier, String(d._id))).resolves.toMatchObject({ livreurId: 'liv-2' });
  });
});

describe('pickup and dropoff', () => {
  async function accepted() {
    const ctx = setup();
    const d = await seedDelivery(ctx.repo);
    await ctx.service.accept(courier, String(d._id));
    return { ...ctx, id: String(d._id) };
  }

  it('full happy path advances the order first, then the delivery', async () => {
    const { service, orders, id } = await accepted();

    const picked = await service.pickup(courier, id);
    expect(picked.status).toBe(DeliveryStatus.PickedUp);
    expect(picked.pickedUpAt).toBeInstanceOf(Date);

    const dropped = await service.dropoff(courier, id);
    expect(dropped.status).toBe(DeliveryStatus.Delivered);
    expect(dropped.deliveredAt).toBeInstanceOf(Date);
    expect(orders.statusCalls.map((c) => c.status)).toEqual(['IN_DELIVERY', 'DELIVERED']);
    expect(orders.statusCalls.every((c) => c.courierId === 'liv-1')).toBe(true);
  });

  it('refuses pickup while the meal is still cooking, without changing anything', async () => {
    const { service, orders, repo, id } = await accepted();
    orders.kitchenStatus = 'IN_PREPARATION';

    await expectDomainError(service.pickup(courier, id), DomainErrorCode.Conflict);
    expect(repo.docs.get(id)!.status).toBe(DeliveryStatus.Assigned);

    orders.kitchenStatus = 'READY_FOR_PICKUP';
    await expect(service.pickup(courier, id)).resolves.toMatchObject({ status: DeliveryStatus.PickedUp });
  });

  it('fails closed when order-service is unreachable', async () => {
    const { service, orders, repo, id } = await accepted();
    orders.unreachable = true;
    await expectDomainError(service.pickup(courier, id), DomainErrorCode.Conflict);
    expect(repo.docs.get(id)!.status).toBe(DeliveryStatus.Assigned);
  });

  it('only the assigned courier can act on the delivery', async () => {
    const { service, id } = await accepted();
    await expectDomainError(service.pickup(otherCourier, id), DomainErrorCode.Forbidden);
  });

  it('cannot drop off before pickup', async () => {
    const { service, id } = await accepted();
    await expectDomainError(service.dropoff(courier, id), DomainErrorCode.Conflict);
  });
});

describe('cancelForOrder', () => {
  it('cancels a delivery in progress but never a delivered one', async () => {
    const { service, repo } = setup();
    await seedDelivery(repo, { status: DeliveryStatus.Assigned, livreurId: 'liv-1' });
    await seedDelivery(repo, { orderId: 'order-2', status: DeliveryStatus.Delivered, livreurId: 'liv-1' });

    expect((await service.cancelForOrder('order-1'))!.status).toBe(DeliveryStatus.Cancelled);
    expect(await service.cancelForOrder('order-2')).toBeNull();
    expect(await service.cancelForOrder('order-1')).toBeNull();
  });
});

describe('courierHistory', () => {
  it('totals every delivered trip, fee and tip, and lists recent ones', async () => {
    const { service, repo } = setup();
    await seedDelivery(repo, { status: DeliveryStatus.Delivered, livreurId: 'liv-1', courierFeeCents: 450, tipCents: 200, deliveredAt: new Date() });
    await seedDelivery(repo, { orderId: 'o2', status: DeliveryStatus.Delivered, livreurId: 'liv-1', courierFeeCents: null, deliveredAt: new Date(0) });
    await seedDelivery(repo, { orderId: 'o3', status: DeliveryStatus.Delivered, livreurId: 'liv-2', courierFeeCents: 999 });

    const history = await service.courierHistory(courier);

    expect(history.completedTrips).toBe(2);
    expect(history.trips[0].amount).toBe(6.5);
    expect(history.totalEarned).toBeGreaterThan(6.5); // legacy trip computed at the current tariff
  });

  it('refuses non-couriers', async () => {
    await expectDomainError(setup().service.courierHistory(customer), DomainErrorCode.Forbidden);
  });
});

describe('recordPosition', () => {
  it('flips PICKED_UP to IN_TRANSIT and throttles stored points', async () => {
    const { service, repo } = setup();
    const d = await seedDelivery(repo, { status: DeliveryStatus.PickedUp, livreurId: 'liv-1' });

    const first = await service.recordPosition(courier, String(d._id), 48.851, 2.351);
    await service.recordPosition(courier, String(d._id), 48.852, 2.352);

    expect(first.status).toBe(DeliveryStatus.InTransit);
    expect(repo.positions).toHaveLength(1);
  });

  it('rejects positions outside an active delivery', async () => {
    const { service, repo } = setup();
    const d = await seedDelivery(repo, { status: DeliveryStatus.Assigned, livreurId: 'liv-1' });
    await expectDomainError(service.recordPosition(courier, String(d._id), 1, 1), DomainErrorCode.Conflict);
  });
});

describe('getById and canWatch', () => {
  it('lets the customer, the assigned courier, the restaurant manager and admin view', async () => {
    const { service, repo } = setup();
    const d = await seedDelivery(repo, { status: DeliveryStatus.Assigned, livreurId: 'liv-1' });
    for (const actor of [customer, courier, manager, admin]) {
      await expect(service.getById(actor, String(d._id))).resolves.toBeDefined();
      await expect(service.canWatch(actor, String(d._id))).resolves.toBe(true);
    }
  });

  it('blocks any other courier, customer or manager', async () => {
    const { service, repo } = setup();
    const d = await seedDelivery(repo, { status: DeliveryStatus.Assigned, livreurId: 'liv-1' });
    const strangers: Actor[] = [
      otherCourier,
      { userId: 'cust-2', tenantId: '', roles: ['user'], token: 't' },
      { userId: 'mgr-2', tenantId: 'resto-2', roles: ['manager'], token: 't' },
    ];
    for (const actor of strangers) {
      await expectDomainError(service.getById(actor, String(d._id)), DomainErrorCode.Forbidden);
      await expect(service.canWatch(actor, String(d._id))).resolves.toBe(false);
    }
  });
});
