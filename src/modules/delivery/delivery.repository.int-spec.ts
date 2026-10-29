import mongoose, { Model } from 'mongoose';
import { MongooseDeliveryRepository } from './delivery.repository';
import { DeliveryDocument, DeliverySchema, DeliveryStatus, toGeoJson } from './entities/delivery.schema';
import { PositionUpdateDocument, PositionUpdateSchema } from './entities/position-update.schema';

/**
 * Runs against a real MongoDB (2dsphere queries, conditional updates):
 *   MONGO_TEST_URI=mongodb://localhost:27018/delivery_it npx jest --testRegex int-spec
 */
const uri = process.env.MONGO_TEST_URI;
const describeIfMongo = uri ? describe : describe.skip;

describeIfMongo('MongooseDeliveryRepository (MongoDB)', () => {
  let deliveries: Model<DeliveryDocument>;
  let repo: MongooseDeliveryRepository;

  beforeAll(async () => {
    await mongoose.connect(uri as string);
    deliveries = mongoose.model('Delivery', DeliverySchema) as unknown as Model<DeliveryDocument>;
    const positions = mongoose.model('PositionUpdate', PositionUpdateSchema) as unknown as Model<PositionUpdateDocument>;
    await deliveries.deleteMany({});
    await deliveries.syncIndexes();
    repo = new MongooseDeliveryRepository(deliveries, positions);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  const create = (orderId: string, pickup: { lat: number; lng: number }) =>
    repo.create({
      orderId,
      customerId: 'c1',
      restaurantId: 'r1',
      status: DeliveryStatus.Unassigned,
      pickup: { address: 'resto', ...pickup },
      dropoff: { address: 'client', lat: 48.86, lng: 2.36 },
      pickupLocation: toGeoJson(pickup),
    });

  it('lets one courier only claim a delivery, even concurrently', async () => {
    const d = await create('order-claim', { lat: 48.85, lng: 2.35 });

    const results = await Promise.all(
      ['liv-1', 'liv-2', 'liv-3', 'liv-4'].map((c) => repo.claim(String(d._id), c, new Date())),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('only moves a delivery of the right courier from an allowed status', async () => {
    const d = await create('order-transition', { lat: 48.85, lng: 2.35 });
    await repo.claim(String(d._id), 'liv-1', new Date());

    expect(await repo.transition(String(d._id), 'liv-2', [DeliveryStatus.Assigned], DeliveryStatus.PickedUp)).toBeNull();
    expect(await repo.transition(String(d._id), 'liv-1', [DeliveryStatus.PickedUp], DeliveryStatus.Delivered)).toBeNull();
    const picked = await repo.transition(String(d._id), 'liv-1', [DeliveryStatus.Assigned], DeliveryStatus.PickedUp);
    expect(picked?.status).toBe(DeliveryStatus.PickedUp);

    expect((await repo.cancelByOrder('order-transition', new Date()))?.status).toBe(DeliveryStatus.Cancelled);
    expect(await repo.cancelByOrder('order-transition', new Date())).toBeNull();
  });

  it('lists available deliveries around a point, closest first', async () => {
    await create('order-near', { lat: 48.8566, lng: 2.3522 }); // Paris centre
    await create('order-mid', { lat: 48.8738, lng: 2.295 }); // ~5 km
    await create('order-far', { lat: 48.8049, lng: 2.1204 }); // Versailles, ~18 km

    const around = await repo.listAvailable({ lat: 48.857, lng: 2.352, radiusKm: 8 }, 10);

    const ids = around.map((d) => d.orderId);
    expect(ids).toContain('order-near');
    expect(ids).toContain('order-mid');
    expect(ids).not.toContain('order-far');
    expect(ids.indexOf('order-near')).toBeLessThan(ids.indexOf('order-mid'));
  });

  it('sums a courier earnings in the database', async () => {
    const d = await create('order-paid', { lat: 48.85, lng: 2.35 });
    await deliveries.updateOne(
      { _id: d._id },
      { $set: { status: DeliveryStatus.Delivered, livreurId: 'liv-sum', courierFeeCents: 500, tipCents: 150 } },
    );

    expect(await repo.earningsOf('liv-sum')).toEqual({ storedCents: 650, completedTrips: 1 });
  });

  it('hides the handover code from ordinary reads and rates once', async () => {
    const d = await repo.create({
      orderId: 'order-code',
      customerId: 'c1',
      restaurantId: 'r1',
      status: DeliveryStatus.Delivered,
      livreurId: 'liv-rate',
      pickup: { address: 'resto', lat: 48.85, lng: 2.35 },
      dropoff: { address: 'client', lat: 48.86, lng: 2.36 },
      handoverCode: '0420',
    });

    expect((await repo.findById(String(d._id)))?.handoverCode).toBeUndefined();
    expect(await repo.handoverCodeOf(String(d._id))).toBe('0420');

    expect(await repo.rate(String(d._id), 'someone-else', 5, '', new Date())).toBeNull();
    expect((await repo.rate(String(d._id), 'c1', 4, 'ok', new Date()))?.rating).toBe(4);
    expect(await repo.rate(String(d._id), 'c1', 1, '', new Date())).toBeNull();
    expect(await repo.ratingOf('liv-rate')).toEqual({ average: 4, count: 1 });
  });
});
