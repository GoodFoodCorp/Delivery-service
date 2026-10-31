import { CourierEarnings, DeliveryRepository, NearQuery } from '../delivery.repository';
import { ReadyOrder } from '../orders.client';
import { RestaurantLocation } from '../restaurants.client';
import { ACTIVE_STATUSES, Delivery, DeliveryDocument, DeliveryStatus } from '../entities/delivery.schema';
import { DomainError } from '../../../common/errors';

/** In-memory DeliveryRepository with the same conditional semantics as Mongo. */
export type FakeDoc = Delivery & { _id: string; createdAt: Date };

export class FakeRepo implements DeliveryRepository {
  docs = new Map<string, FakeDoc>();
  positions: { deliveryId: string; lat: number; lng: number; timestamp: Date }[] = [];
  private seq = 0;

  private out(doc: FakeDoc | undefined | null): DeliveryDocument | null {
    return doc ? ({ ...doc } as unknown as DeliveryDocument) : null;
  }

  async findById(id: string) {
    return this.out(this.docs.get(id));
  }
  async findByOrderId(orderId: string) {
    return this.out([...this.docs.values()].find((d) => d.orderId === orderId));
  }
  async listAvailable(_near: NearQuery | null, limit: number) {
    return [...this.docs.values()]
      .filter((d) => d.status === DeliveryStatus.Unassigned)
      .slice(0, limit)
      .map((d) => this.out(d)!) as DeliveryDocument[];
  }
  async listByCourier(courierId: string, statuses: DeliveryStatus[]) {
    return [...this.docs.values()]
      .filter((d) => d.livreurId === courierId && statuses.includes(d.status))
      .map((d) => this.out(d)!) as DeliveryDocument[];
  }
  async create(data: Partial<Delivery>) {
    if ([...this.docs.values()].some((d) => d.orderId === data.orderId)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    const doc = {
      _id: `d${++this.seq}`.padEnd(24, '0'),
      livreurId: null,
      assignedAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      cancelledAt: null,
      estimatedDeliveryTime: null,
      courierFeeCents: null,
      tipCents: 0,
      handoverCode: null,
      handoverAttempts: 0,
      rating: null,
      ratedAt: null,
      createdAt: new Date(),
      ...data,
    } as FakeDoc;
    this.docs.set(doc._id, doc);
    return this.out(doc)!;
  }
  async claim(id: string, courierId: string, at: Date) {
    const d = this.docs.get(id);
    if (!d || d.status !== DeliveryStatus.Unassigned) return null;
    Object.assign(d, { status: DeliveryStatus.Assigned, livreurId: courierId, assignedAt: at });
    return this.out(d);
  }
  async release(id: string, courierId: string) {
    const d = this.docs.get(id);
    if (!d || d.status !== DeliveryStatus.Assigned || d.livreurId !== courierId) return null;
    Object.assign(d, { status: DeliveryStatus.Unassigned, livreurId: null, assignedAt: null });
    return this.out(d);
  }
  async transition(id: string, courierId: string, from: DeliveryStatus[], to: DeliveryStatus, set: Partial<Delivery> = {}) {
    const d = this.docs.get(id);
    if (!d || d.livreurId !== courierId || !from.includes(d.status)) return null;
    Object.assign(d, set, { status: to });
    return this.out(d);
  }
  async cancelByOrder(orderId: string, at: Date) {
    const d = [...this.docs.values()].find((x) => x.orderId === orderId);
    if (!d || d.status === DeliveryStatus.Delivered || d.status === DeliveryStatus.Cancelled) return null;
    Object.assign(d, { status: DeliveryStatus.Cancelled, cancelledAt: at });
    return this.out(d);
  }
  async addPosition(deliveryId: string, lat: number, lng: number, timestamp: Date) {
    this.positions.push({ deliveryId, lat, lng, timestamp });
    return this.positions[this.positions.length - 1] as never;
  }
  async lastPosition(deliveryId: string) {
    const list = this.positions.filter((p) => p.deliveryId === deliveryId);
    return (list[list.length - 1] ?? null) as never;
  }
  async listActiveCourierIds() {
    return [...this.docs.values()]
      .filter((d) => d.livreurId && ACTIVE_STATUSES.includes(d.status))
      .map((d) => d.livreurId as string);
  }
  private delivered(courierId: string) {
    return [...this.docs.values()]
      .filter((d) => d.livreurId === courierId && d.status === DeliveryStatus.Delivered)
      .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0));
  }
  async listDeliveredByCourier(courierId: string, limit: number) {
    return this.delivered(courierId).slice(0, limit).map((d) => this.out(d)!) as DeliveryDocument[];
  }
  async listLegacyDeliveredByCourier(courierId: string) {
    return this.delivered(courierId).filter((d) => d.courierFeeCents === null).map((d) => this.out(d)!) as DeliveryDocument[];
  }
  async handoverCodeOf(id: string) {
    return this.docs.get(id)?.handoverCode ?? null;
  }
  async recordHandoverAttempt(id: string) {
    const d = this.docs.get(id)!;
    d.handoverAttempts = (d.handoverAttempts ?? 0) + 1;
    return d.handoverAttempts;
  }
  async rate(id: string, customerId: string, rating: number, at: Date) {
    const d = this.docs.get(id);
    if (!d || d.customerId !== customerId || d.status !== DeliveryStatus.Delivered || d.rating) return null;
    Object.assign(d, { rating, ratedAt: at });
    return this.out(d);
  }
  async ratingOf(courierId: string) {
    const rated = [...this.docs.values()].filter((d) => d.livreurId === courierId && d.rating);
    if (!rated.length) return { average: null, count: 0 };
    return { average: rated.reduce((s, d) => s + (d.rating as number), 0) / rated.length, count: rated.length };
  }
  async earningsOf(courierId: string): Promise<CourierEarnings> {
    const list = this.delivered(courierId);
    return {
      storedCents: list.reduce((s, d) => s + (d.courierFeeCents ?? 0) + (d.tipCents ?? 0), 0),
      completedTrips: list.length,
    };
  }
}

/** Stands in for order-service's internal API, with its courier rules. */
export class FakeOrders {
  awaiting: ReadyOrder[] = [];
  kitchenStatus = 'READY_FOR_PICKUP';
  couriers = new Map<string, string>();
  statusCalls: { orderId: string; status: string; courierId: string }[] = [];
  unreachable = false;

  private guard() {
    if (this.unreachable) throw DomainError.conflict('order-service unreachable');
  }
  async listAwaitingCourier() {
    this.guard();
    return this.awaiting;
  }
  async getOrder(orderId: string): Promise<ReadyOrder> {
    this.guard();
    return { id: orderId, customer_id: 'cust-1', restaurant_id: 'resto-1', delivery_address: '1 rue A', status: this.kitchenStatus };
  }
  async assignCourier(orderId: string, courierId: string) {
    this.guard();
    const holder = this.couriers.get(orderId);
    if (holder && holder !== courierId) throw DomainError.conflict('order already claimed by another courier');
    this.couriers.set(orderId, courierId);
  }
  async unassignCourier(orderId: string, courierId: string) {
    this.guard();
    if (this.couriers.get(orderId) === courierId) this.couriers.delete(orderId);
  }
  async updateOrderStatus(orderId: string, status: string, courierId: string) {
    this.guard();
    if (this.couriers.get(orderId) !== courierId) throw DomainError.forbidden('this delivery is assigned to another courier');
    if (status === 'IN_DELIVERY' && this.kitchenStatus !== 'READY_FOR_PICKUP') {
      throw DomainError.conflict(`invalid transition from ${this.kitchenStatus} to IN_DELIVERY`);
    }
    this.statusCalls.push({ orderId, status, courierId });
  }
}

export class FakeRestaurants {
  locations = new Map<string, RestaurantLocation>();
  async get(id: string) {
    return this.locations.get(id) ?? null;
  }
}
