import { Actor } from '../../common/auth.util';
import { DomainError, DomainErrorCode } from '../../common/errors';
import { DeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { OrdersClient, ReadyOrder } from './orders.client';
import { Delivery, DeliveryDocument, DeliveryStatus } from './entities/delivery.schema';

// ── In-memory fakes ─────────────────────────────────────────

type FakeDoc = Delivery & { _id: string; save: () => Promise<FakeDoc> };

class FakeRepo implements DeliveryRepository {
  docs = new Map<string, FakeDoc>();
  positions: { deliveryId: string; lat: number; lng: number; timestamp: Date }[] = [];
  private seq = 0;

  private wrap(data: Partial<Delivery>): FakeDoc {
    const doc = {
      _id: `d${++this.seq}`.padEnd(24, '0'),
      livreurId: null,
      assignedAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      estimatedDeliveryTime: null,
      ...data,
    } as unknown as FakeDoc;
    doc.save = async () => doc;
    return doc;
  }

  async findById(id: string) {
    return (this.docs.get(id) ?? null) as unknown as DeliveryDocument | null;
  }
  async findByOrderId(orderId: string) {
    return ([...this.docs.values()].find((d) => d.orderId === orderId) ?? null) as unknown as DeliveryDocument | null;
  }
  async listByStatus(status: DeliveryStatus) {
    return [...this.docs.values()].filter((d) => d.status === status) as unknown as DeliveryDocument[];
  }
  async listByCourier(courierId: string, statuses: DeliveryStatus[]) {
    return [...this.docs.values()].filter(
      (d) => d.livreurId === courierId && statuses.includes(d.status),
    ) as unknown as DeliveryDocument[];
  }
  async create(data: Partial<Delivery>) {
    const doc = this.wrap(data);
    this.docs.set(doc._id, doc);
    return doc as unknown as DeliveryDocument;
  }
  async save(doc: DeliveryDocument) {
    return doc;
  }
  async addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date) {
    this.positions.push({ deliveryId, lat, lng, timestamp });
    return this.positions[this.positions.length - 1] as never;
  }
  async lastPosition(deliveryId: string) {
    const list = this.positions.filter((p) => p.deliveryId === deliveryId);
    return (list[list.length - 1] ?? null) as never;
  }
  async listDeliveredByCourier(courierId: string) {
    return [...this.docs.values()]
      .filter((d) => d.livreurId === courierId && d.status === DeliveryStatus.Delivered)
      .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0)) as unknown as DeliveryDocument[];
  }
  async listActiveCourierIds() {
    const active = [DeliveryStatus.Assigned, DeliveryStatus.PickedUp, DeliveryStatus.InTransit];
    return [...this.docs.values()]
      .filter((d) => d.livreurId && active.includes(d.status))
      .map((d) => d.livreurId as string);
  }
}

class FakeOrders {
  ready: ReadyOrder[] = [];
  statusCalls: { orderId: string; status: string }[] = [];
  /** What the kitchen reports for getOrder — drives the pickup guard. */
  orderStatus = 'READY_FOR_PICKUP';
  async listReadyForDelivery() {
    return this.ready;
  }
  async getOrder(orderId: string): Promise<ReadyOrder> {
    return {
      id: orderId,
      customer_id: 'cust-1',
      restaurant_id: 'resto-1',
      delivery_address: '1 rue A',
      status: this.orderStatus,
    };
  }
  async updateOrderStatus(orderId: string, status: string) {
    this.statusCalls.push({ orderId, status });
  }
}

// ── Fixtures ────────────────────────────────────────────────

const courier: Actor = { userId: 'liv-1', tenantId: '', roles: ['livreur'], token: 't' };
const otherCourier: Actor = { userId: 'liv-2', tenantId: '', roles: ['livreur'], token: 't' };
const customer: Actor = { userId: 'cust-1', tenantId: '', roles: ['user'], token: 't' };
const manager: Actor = { userId: 'mgr-1', tenantId: 'resto-1', roles: ['manager'], token: 't' };

function setup() {
  const repo = new FakeRepo();
  const orders = new FakeOrders();
  const service = new DeliveryService(repo, orders as unknown as OrdersClient);
  return { repo, orders, service };
}

async function seedDelivery(repo: FakeRepo, overrides: Partial<Delivery> = {}) {
  return repo.create({
    orderId: 'order-1',
    customerId: 'cust-1',
    restaurantId: 'resto-1',
    status: DeliveryStatus.Unassigned,
    pickup: { address: 'resto', lat: 48.85, lng: 2.35 },
    dropoff: { address: 'client', lat: 48.86, lng: 2.36 },
    ...overrides,
  });
}

async function expectDomainError(promise: Promise<unknown>, code: DomainErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((e) => expect(e).toBeInstanceOf(DomainError));
}

describe('registerReadyOrder', () => {
  const order: ReadyOrder = {
    id: 'order-9',
    customer_id: 'cust-9',
    restaurant_id: 'resto-9',
    delivery_address: '1 rue A',
  };

  it('creates an UNASSIGNED delivery and reports it as created', async () => {
    const { repo, service } = setup();

    const result = await service.registerReadyOrder(order);

    expect(result.created).toBe(true);
    expect(result.delivery.orderId).toBe('order-9');
    expect(result.delivery.status).toBe(DeliveryStatus.Unassigned);
    expect(repo.docs.size).toBe(1);
  });

  it('stores the courier fee computed from the pickup/dropoff distance', async () => {
    const { service } = setup();

    const { delivery } = await service.registerReadyOrder(order);

    expect(delivery.courierFeeCents).toBeGreaterThanOrEqual(300);
  });

  it('is idempotent: a redelivered event does not create a second delivery', async () => {
    const { repo, service } = setup();
    await service.registerReadyOrder(order);

    const again = await service.registerReadyOrder(order);

    expect(again.created).toBe(false);
    expect(repo.docs.size).toBe(1);
  });

  it('treats a duplicate-key error from a concurrent creation as already created', async () => {
    const { repo, service } = setup();
    const existing = await seedDelivery(repo, { orderId: 'order-9' });
    const findSpy = jest.spyOn(repo, 'findByOrderId');
    findSpy.mockResolvedValueOnce(null); // lost the race: not visible at first check
    jest.spyOn(repo, 'create').mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    const result = await service.registerReadyOrder(order);

    expect(result.created).toBe(false);
    expect(result.delivery).toBe(existing);
  });
});

describe('courierHistory', () => {
  const delivered = (overrides: Partial<Delivery>) =>
    ({
      status: DeliveryStatus.Delivered,
      livreurId: 'liv-1',
      ...overrides,
    }) as Partial<Delivery>;

  it('lists only the connected courier\'s delivered trips, newest first, with their fee', async () => {
    const { repo, service } = setup();
    await seedDelivery(repo, delivered({ orderId: 'o-old', courierFeeCents: 400, deliveredAt: new Date('2026-10-01T10:00:00Z') }));
    await seedDelivery(repo, delivered({ orderId: 'o-new', courierFeeCents: 500, deliveredAt: new Date('2026-10-02T10:00:00Z') }));
    await seedDelivery(repo, delivered({ orderId: 'o-other', livreurId: 'liv-2', courierFeeCents: 999 }));
    await seedDelivery(repo, { orderId: 'o-active', livreurId: 'liv-1', status: DeliveryStatus.PickedUp });

    const history = await service.courierHistory(courier);

    expect(history.trips.map((t) => t.orderId)).toEqual(['o-new', 'o-old']);
    expect(history.trips[0]).toMatchObject({ amount: 5, pickupAddress: 'resto', dropoffAddress: 'client' });
    expect(history.completedTrips).toBe(2);
    expect(history.totalEarned).toBe(9);
    expect(history.availableBalance).toBe(9);
  });

  it('computes the fee on the fly for deliveries created before fees were stored', async () => {
    const { repo, service } = setup();
    await seedDelivery(repo, delivered({ orderId: 'o-legacy', deliveredAt: new Date('2026-10-01T10:00:00Z') }));

    const history = await service.courierHistory(courier);

    expect(history.trips).toHaveLength(1);
    expect(history.trips[0].amount).toBeGreaterThanOrEqual(3);
    expect(history.totalEarned).toBe(history.trips[0].amount);
  });

  it('returns an empty history for a courier with no delivered trip', async () => {
    const { service } = setup();

    const history = await service.courierHistory(courier);

    expect(history).toEqual({ totalEarned: 0, availableBalance: 0, completedTrips: 0, trips: [] });
  });

  it('refuses non-couriers', async () => {
    const { service } = setup();
    await expectDomainError(service.courierHistory(customer), DomainErrorCode.Forbidden);
  });
});

// ── listAvailable / sync ────────────────────────────────────

describe('listAvailable', () => {
  it('creates UNASSIGNED deliveries for new ready orders', async () => {
    const { repo, orders, service } = setup();
    orders.ready = [
      { id: 'order-9', customer_id: 'cust-9', restaurant_id: 'resto-9', delivery_address: '1 rue A', status: 'READY_FOR_PICKUP' },
    ];

    const list = await service.listAvailable(courier);

    expect(list).toHaveLength(1);
    expect(list[0].orderId).toBe('order-9');
    expect(list[0].status).toBe(DeliveryStatus.Unassigned);
    expect(list[0].pickup.lat).toBeDefined();
    expect(repo.docs.size).toBe(1);
  });

  it('does not duplicate deliveries for already-synced orders', async () => {
    const { repo, orders, service } = setup();
    await seedDelivery(repo, { orderId: 'order-9' });
    orders.ready = [
      { id: 'order-9', customer_id: 'cust-9', restaurant_id: 'resto-9', delivery_address: '1 rue A', status: 'READY_FOR_PICKUP' },
    ];

    await service.listAvailable(courier);
    expect(repo.docs.size).toBe(1);
  });

  it('offers orders that are still being prepared, so a courier can travel meanwhile', async () => {
    const { repo, orders, service } = setup();
    orders.ready = [
      { id: 'order-7', customer_id: 'cust-7', restaurant_id: 'resto-7', delivery_address: '7 rue B', status: 'IN_PREPARATION' },
    ];

    const list = await service.listAvailable(courier);

    expect(list).toHaveLength(1);
    expect(list[0].orderId).toBe('order-7');
    expect(list[0].status).toBe(DeliveryStatus.Unassigned);
    expect(repo.docs.size).toBe(1);
  });

  it('rejects non-couriers', async () => {
    const { service } = setup();
    await expectDomainError(service.listAvailable(customer), DomainErrorCode.Forbidden);
  });
});

// ── accept ──────────────────────────────────────────────────

describe('accept', () => {
  it('accepts a delivery using its order id', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo, { orderId: 'order-9' });

    const accepted = await service.accept(courier, 'order-9');

    expect(accepted).toBe(doc);
    expect(accepted.status).toBe(DeliveryStatus.Assigned);
    expect(accepted.livreurId).toBe('liv-1');
  });

  it('assigns the courier without advancing the order', async () => {
    const { repo, orders, service } = setup();
    const doc = await seedDelivery(repo);

    const accepted = await service.accept(courier, (doc as never as FakeDoc)._id);

    expect(accepted.status).toBe(DeliveryStatus.Assigned);
    expect(accepted.livreurId).toBe('liv-1');
    expect(accepted.assignedAt).toBeInstanceOf(Date);
    // The kitchen still owns the order until the meal is actually collected.
    expect(orders.statusCalls).toEqual([]);
  });

  it('can be accepted while the order is still in preparation', async () => {
    const { repo, orders, service } = setup();
    orders.orderStatus = 'IN_PREPARATION';
    const doc = await seedDelivery(repo);

    const accepted = await service.accept(courier, (doc as never as FakeDoc)._id);

    expect(accepted.status).toBe(DeliveryStatus.Assigned);
    expect(orders.statusCalls).toEqual([]);
  });

  it('refuses an already-assigned delivery', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo, { status: DeliveryStatus.Assigned, livreurId: 'liv-2' });

    await expectDomainError(service.accept(courier, (doc as never as FakeDoc)._id), DomainErrorCode.Conflict);
  });

  it('404s on unknown delivery', async () => {
    const { service } = setup();
    await expectDomainError(service.accept(courier, 'missing'), DomainErrorCode.NotFound);
  });
});

// ── pickup / dropoff ────────────────────────────────────────

describe('pickup and dropoff', () => {
  it('full happy path stamps timestamps and notifies order-service', async () => {
    const { repo, orders, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;

    await service.accept(courier, id);
    const picked = await service.pickup(courier, id);
    expect(picked.status).toBe(DeliveryStatus.PickedUp);
    expect(picked.pickedUpAt).toBeInstanceOf(Date);

    const dropped = await service.dropoff(courier, id);
    expect(dropped.status).toBe(DeliveryStatus.Delivered);
    expect(dropped.deliveredAt).toBeInstanceOf(Date);
    // IN_DELIVERY is pushed at pickup, not at accept.
    expect(orders.statusCalls.map((c) => c.status)).toEqual(['IN_DELIVERY', 'DELIVERED']);
  });

  it('refuses pickup while the meal is still cooking, then allows it once ready', async () => {
    const { repo, orders, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    orders.orderStatus = 'IN_PREPARATION';
    await service.accept(courier, id);

    // Courier arrived early: they wait rather than leave with a raw meal.
    await expectDomainError(service.pickup(courier, id), DomainErrorCode.Conflict);
    expect(orders.statusCalls).toEqual([]);

    orders.orderStatus = 'READY_FOR_PICKUP';
    const picked = await service.pickup(courier, id);
    expect(picked.status).toBe(DeliveryStatus.PickedUp);
    expect(orders.statusCalls).toEqual([{ orderId: 'order-1', status: 'IN_DELIVERY' }]);
  });

  it('fails closed when order-service cannot confirm the order is ready', async () => {
    const { repo, orders, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    await service.accept(courier, id);
    orders.getOrder = async () => {
      throw DomainError.conflict('order-service unreachable');
    };

    await expectDomainError(service.pickup(courier, id), DomainErrorCode.Conflict);
    expect(orders.statusCalls).toEqual([]);
  });

  it('only the assigned courier can act on the delivery', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    await service.accept(courier, id);

    await expectDomainError(service.pickup(otherCourier, id), DomainErrorCode.Forbidden);
    await expectDomainError(service.dropoff(otherCourier, id), DomainErrorCode.Forbidden);
  });

  it('cannot pick up before accepting or drop off before pickup', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;

    await expectDomainError(service.pickup(courier, id), DomainErrorCode.Forbidden); // not assigned to courier
    await service.accept(courier, id);
    await expectDomainError(service.dropoff(courier, id), DomainErrorCode.Conflict); // not picked up yet
  });
});

// ── positions & tracking access ─────────────────────────────

describe('recordPosition', () => {
  it('stores the point and flips PICKED_UP to IN_TRANSIT', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    await service.accept(courier, id);
    await service.pickup(courier, id);

    const first = await service.recordPosition(courier, id, 48.857, 2.351);
    expect(first.status).toBe(DeliveryStatus.InTransit);
    expect(repo.positions).toHaveLength(1);

    await service.recordPosition(courier, id, 48.858, 2.352);
    expect(repo.positions).toHaveLength(2);
  });

  it('rejects positions outside an active delivery', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    await service.accept(courier, id);

    await expectDomainError(service.recordPosition(courier, id, 48.85, 2.35), DomainErrorCode.Conflict);
  });
});

describe('getById and canWatch', () => {
  it('lets owner, courier, manager of the restaurant and admin view', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;

    await expect(service.getById(customer, id)).resolves.toBeDefined();
    await expect(service.getById(manager, id)).resolves.toBeDefined();
    await expect(service.getById(courier, id)).resolves.toBeDefined();
  });

  it('blocks unrelated customers and managers', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    const stranger: Actor = { userId: 'cust-x', tenantId: '', roles: ['user'], token: 't' };
    const otherManager: Actor = { userId: 'mgr-2', tenantId: 'resto-99', roles: ['manager'], token: 't' };

    await expectDomainError(service.getById(stranger, id), DomainErrorCode.Forbidden);
    await expectDomainError(service.getById(otherManager, id), DomainErrorCode.Forbidden);

    expect(await service.canWatch(stranger, id)).toBe(false);
    expect(await service.canWatch(customer, id)).toBe(true);
  });

  it('returns the last known position', async () => {
    const { repo, service } = setup();
    const doc = await seedDelivery(repo);
    const id = (doc as never as FakeDoc)._id;
    await service.accept(courier, id);
    await service.pickup(courier, id);
    await service.recordPosition(courier, id, 48.857, 2.351);
    await service.recordPosition(courier, id, 48.859, 2.353);

    const detail = await service.getById(customer, id);
    expect(detail.lastPosition).toMatchObject({ lat: 48.859, lng: 2.353 });
  });
});
