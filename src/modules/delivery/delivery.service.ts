import { Inject, Injectable, Logger } from '@nestjs/common';
import { Actor } from '../../common/auth.util';
import { DomainError, DomainErrorCode } from '../../common/errors';
import { DELIVERY_REPOSITORY, DeliveryRepository, NearQuery } from './delivery.repository';
import { computeCourierFeeCents, distanceKm, estimateDeliveryTime, pseudoCoordinates } from './geo';
import { OrdersClient, ReadyOrder } from './orders.client';
import { RestaurantsClient } from './restaurants.client';
import {
  ACTIVE_STATUSES,
  Delivery,
  DeliveryDocument,
  DeliveryStatus,
  toGeoJson,
} from './entities/delivery.schema';

const ROLE_COURIER = 'livreur';
const ROLE_ADMIN = 'admin';
const ROLE_MANAGER = 'manager';

/** Bounds of the lists returned at once. */
const MAX_AVAILABLE = 100;
const HISTORY_PAGE = 50;

/** A courier's GPS point is stored at most this often (the live feed still gets every point). */
const POSITION_STORE_INTERVAL_MS = 3000;

const ORDER_IN_DELIVERY = 'IN_DELIVERY';
const ORDER_DELIVERED = 'DELIVERED';
const FULFILLMENT_PICKUP = 'PICKUP';

/** What a courier sees of a delivery before accepting it: enough to decide, no customer data. */
export interface AvailableDeliveryView {
  id: string;
  orderId: string;
  pickup: { address: string; lat: number; lng: number };
  /** Drop-off area only: the exact address is revealed once accepted. */
  dropoffArea: { lat: number; lng: number };
  distanceKm: number;
  courierFeeCents: number;
  tipCents: number;
  estimatedDeliveryTime: Date | null;
  createdAt?: Date;
}

/** Business logic and orchestration — no HTTP/WS concern in here. */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private readonly lastStoredPosition = new Map<string, number>();

  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
    private readonly orders: OrdersClient,
    private readonly restaurants: RestaurantsClient,
  ) {}

  // ── Deliveries lifecycle ──────────────────────────────────

  /**
   * Creates the UNASSIGNED delivery of an order awaiting a courier. Idempotent:
   * shared by the order event consumer and the reconciliation job. Pickups
   * (click & collect) never get a delivery.
   */
  async registerReadyOrder(order: ReadyOrder): Promise<{ delivery: DeliveryDocument | null; created: boolean }> {
    if (order.fulfillment === FULFILLMENT_PICKUP) {
      return { delivery: null, created: false };
    }
    const existing = await this.repo.findByOrderId(order.id);
    if (existing) {
      return { delivery: existing, created: false };
    }

    const restaurant = await this.restaurants.get(order.restaurant_id);
    const pickupKnown = restaurant?.lat != null && restaurant?.lng != null;
    const pickupPoint = pickupKnown
      ? { lat: restaurant!.lat as number, lng: restaurant!.lng as number }
      : pseudoCoordinates(order.restaurant_id);
    const dropoffKnown = order.dropoff_lat != null && order.dropoff_lng != null;
    const dropoffPoint = dropoffKnown
      ? { lat: order.dropoff_lat as number, lng: order.dropoff_lng as number }
      : pseudoCoordinates(order.id);

    const pickup = { address: restaurant?.address ?? `Restaurant ${order.restaurant_id.slice(0, 8)}`, ...pickupPoint };
    const dropoff = { address: order.delivery_address, ...dropoffPoint };
    try {
      const delivery = await this.repo.create({
        orderId: order.id,
        customerId: order.customer_id,
        restaurantId: order.restaurant_id,
        status: DeliveryStatus.Unassigned,
        pickup,
        dropoff,
        pickupLocation: toGeoJson(pickup),
        locationApproximate: !pickupKnown || !dropoffKnown,
        estimatedDeliveryTime: estimateDeliveryTime(pickup, dropoff),
        courierFeeCents: computeCourierFeeCents(pickup, dropoff),
        tipCents: order.tip_cents ?? 0,
      });
      return { delivery, created: true };
    } catch (err) {
      // Unique index on orderId: a concurrent consumer/reconciliation created it first.
      if ((err as { code?: number }).code === 11000) {
        const raced = await this.repo.findByOrderId(order.id);
        if (raced) return { delivery: raced, created: false };
      }
      throw err;
    }
  }

  /**
   * Safety net behind the order events: creates the deliveries of orders
   * awaiting a courier whose event was missed. Run periodically by one
   * replica (see ReconcileJob), never on a courier's request.
   */
  async reconcile(requestId?: string): Promise<DeliveryDocument[]> {
    const created: DeliveryDocument[] = [];
    for (const order of await this.orders.listAwaitingCourier(requestId)) {
      const { delivery, created: isNew } = await this.registerReadyOrder(order);
      if (isNew && delivery) created.push(delivery);
    }
    return created;
  }

  /** The order was cancelled: the delivery stops, whatever its stage. */
  async cancelForOrder(orderId: string): Promise<DeliveryDocument | null> {
    return this.repo.cancelByOrder(orderId, new Date());
  }

  /** Deliveries a courier can accept, closest first when the courier's position is given. */
  async listAvailable(actor: Actor, near: NearQuery | null = null): Promise<AvailableDeliveryView[]> {
    this.ensureRole(actor, ROLE_COURIER, ROLE_ADMIN);
    const list = await this.repo.listAvailable(near, MAX_AVAILABLE);
    return list.map((d) => this.toAvailableView(d));
  }

  /** Lists the active deliveries assigned to the connected courier. */
  async listMine(actor: Actor): Promise<DeliveryDocument[]> {
    this.ensureRole(actor, ROLE_COURIER);
    return this.repo.listByCourier(actor.userId, ACTIVE_STATUSES);
  }

  /**
   * Courier claims the delivery (UNASSIGNED → ASSIGNED), atomically: of two
   * couriers accepting at once, exactly one wins. The order records its
   * courier too; if order-service refuses, the claim is rolled back.
   *
   * The order itself is not advanced: a courier can claim an order that is
   * still IN_PREPARATION and drive to the restaurant meanwhile. It moves to
   * IN_DELIVERY at pickup.
   */
  async accept(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    this.ensureRole(actor, ROLE_COURIER);
    const delivery = await this.getOrThrow(deliveryId);
    const claimed = await this.repo.claim(String(delivery._id), actor.userId, new Date());
    if (!claimed) {
      throw DomainError.conflict('this delivery is already assigned');
    }
    try {
      await this.orders.assignCourier(claimed.orderId, actor.userId, requestId);
    } catch (err) {
      await this.repo.release(String(claimed._id), actor.userId);
      throw err;
    }
    return claimed;
  }

  /** The courier gives the delivery up before collecting it. */
  async release(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    const released = await this.repo.release(String(delivery._id), actor.userId);
    if (!released) {
      throw DomainError.conflict(`a delivery in status ${delivery.status} can no longer be released`);
    }
    try {
      await this.orders.unassignCourier(released.orderId, actor.userId, requestId);
    } catch (err) {
      this.logger.warn(`order ${released.orderId} kept courier ${actor.userId}: ${(err as Error).message}`);
    }
    return released;
  }

  /**
   * Courier collects the meal (ASSIGNED → PICKED_UP). The order moves to
   * IN_DELIVERY first: order-service refuses it until the kitchen marked the
   * order READY_FOR_PICKUP, so a courier who arrived early waits instead of
   * leaving with a meal still cooking. Nothing changes here if it refuses.
   */
  async pickup(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    if (delivery.status !== DeliveryStatus.Assigned) {
      throw DomainError.conflict(`cannot pick up a delivery in status ${delivery.status}`);
    }
    await this.advanceOrder(delivery, ORDER_IN_DELIVERY, actor.userId, requestId, 'order is not ready for pickup yet');
    return this.applyTransition(delivery, actor, [DeliveryStatus.Assigned], DeliveryStatus.PickedUp, {
      pickedUpAt: new Date(),
    });
  }

  /** Courier drops the order off (PICKED_UP/IN_TRANSIT → DELIVERED, timestamped). */
  async dropoff(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    const from = [DeliveryStatus.PickedUp, DeliveryStatus.InTransit];
    if (!from.includes(delivery.status)) {
      throw DomainError.conflict(`cannot drop off a delivery in status ${delivery.status}`);
    }
    await this.advanceOrder(delivery, ORDER_DELIVERED, actor.userId, requestId, 'order cannot be marked delivered');
    return this.applyTransition(delivery, actor, from, DeliveryStatus.Delivered, { deliveredAt: new Date() });
  }

  // ── Reads ─────────────────────────────────────────────────

  /** Detail + last known position: the customer, the assigned courier, the restaurant's manager or admin. */
  async getById(actor: Actor, deliveryId: string) {
    const delivery = await this.getOrThrow(deliveryId);
    if (!this.isAllowedToWatch(actor, delivery)) {
      throw DomainError.forbidden('you are not allowed to view this delivery');
    }
    const last = await this.repo.lastPosition(String(delivery._id));
    return {
      delivery,
      lastPosition: last ? { lat: last.lat, lng: last.lng, timestamp: last.timestamp } : null,
    };
  }

  /** Access check for subscribing to a delivery's live tracking feed. */
  async canWatch(actor: Actor, deliveryId: string): Promise<boolean> {
    const delivery = await this.repo.findById(deliveryId).catch(() => null);
    return delivery !== null && this.isAllowedToWatch(actor, delivery);
  }

  /**
   * Earnings of the connected courier: totals over every delivered trip
   * (computed in the database) and the most recent trips. Trips created
   * before fees were stored get the fee computed at the current tariff.
   */
  async courierHistory(actor: Actor, limit = HISTORY_PAGE) {
    this.ensureRole(actor, ROLE_COURIER);
    const [earnings, recent, legacy] = await Promise.all([
      this.repo.earningsOf(actor.userId),
      this.repo.listDeliveredByCourier(actor.userId, limit),
      this.repo.listLegacyDeliveredByCourier(actor.userId),
    ]);
    const legacyCents = legacy.reduce((sum, d) => sum + computeCourierFeeCents(d.pickup, d.dropoff), 0);
    const trips = recent.map((d) => ({
      id: String(d._id),
      orderId: d.orderId,
      pickupAddress: d.pickup.address,
      dropoffAddress: d.dropoff.address,
      deliveredAt: d.deliveredAt,
      amount: ((d.courierFeeCents ?? computeCourierFeeCents(d.pickup, d.dropoff)) + (d.tipCents ?? 0)) / 100,
    }));
    return {
      totalEarned: (earnings.storedCents + legacyCents) / 100,
      completedTrips: earnings.completedTrips,
      trips,
    };
  }

  // ── Live tracking ─────────────────────────────────────────

  /** Stores a courier GPS point (throttled); the first one flips PICKED_UP → IN_TRANSIT. */
  async recordPosition(actor: Actor, deliveryId: string, lat: number, lng: number) {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    if (delivery.status !== DeliveryStatus.PickedUp && delivery.status !== DeliveryStatus.InTransit) {
      throw DomainError.conflict('position updates are only accepted during an active delivery');
    }
    let status = delivery.status;
    if (status === DeliveryStatus.PickedUp) {
      await this.repo.transition(String(delivery._id), actor.userId, [DeliveryStatus.PickedUp], DeliveryStatus.InTransit);
      status = DeliveryStatus.InTransit;
    }
    const timestamp = new Date();
    const id = String(delivery._id);
    if (timestamp.getTime() - (this.lastStoredPosition.get(id) ?? 0) >= POSITION_STORE_INTERVAL_MS) {
      await this.repo.addPosition(id, lat, lng, timestamp);
      this.lastStoredPosition.set(id, timestamp.getTime());
    }
    return { deliveryId: id, lat, lng, timestamp, status };
  }

  /** What couriers are told about a new delivery (no customer data). */
  toAvailableView(d: DeliveryDocument | Delivery & { _id: unknown; createdAt?: Date }): AvailableDeliveryView {
    const round = (v: number) => Math.round(v * 200) / 200; // ~500 m grid
    return {
      id: String(d._id),
      orderId: d.orderId,
      pickup: { address: d.pickup.address, lat: d.pickup.lat, lng: d.pickup.lng },
      dropoffArea: { lat: round(d.dropoff.lat), lng: round(d.dropoff.lng) },
      distanceKm: Math.round(distanceKm(d.pickup, d.dropoff) * 10) / 10,
      courierFeeCents: d.courierFeeCents ?? computeCourierFeeCents(d.pickup, d.dropoff),
      tipCents: d.tipCents ?? 0,
      estimatedDeliveryTime: d.estimatedDeliveryTime,
      createdAt: (d as { createdAt?: Date }).createdAt,
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private async advanceOrder(
    delivery: DeliveryDocument,
    status: string,
    courierId: string,
    requestId: string | undefined,
    refusal: string,
  ): Promise<void> {
    try {
      await this.orders.updateOrderStatus(delivery.orderId, status, courierId, requestId);
    } catch (err) {
      if (err instanceof DomainError && err.code === DomainErrorCode.Conflict) {
        throw DomainError.conflict(`${refusal}: ${err.message}`);
      }
      throw err;
    }
  }

  private async applyTransition(
    delivery: DeliveryDocument,
    actor: Actor,
    from: DeliveryStatus[],
    to: DeliveryStatus,
    set: Partial<Delivery>,
  ): Promise<DeliveryDocument> {
    const updated = await this.repo.transition(String(delivery._id), actor.userId, from, to, set);
    if (!updated) {
      // The order moved but the delivery changed meanwhile (cancelled): report it.
      throw DomainError.conflict('the delivery changed concurrently');
    }
    return updated;
  }

  private isAllowedToWatch(actor: Actor, delivery: Delivery): boolean {
    return (
      actor.roles.includes(ROLE_ADMIN) ||
      delivery.customerId === actor.userId ||
      (delivery.livreurId !== null && delivery.livreurId === actor.userId) ||
      (actor.roles.includes(ROLE_MANAGER) && actor.tenantId === delivery.restaurantId)
    );
  }

  private async getOrThrow(id: string): Promise<DeliveryDocument> {
    let delivery: DeliveryDocument | null = null;
    try {
      delivery = await this.repo.findById(id);
    } catch {
      // not an ObjectId: maybe an order id
    }
    if (!delivery) {
      delivery = await this.repo.findByOrderId(id).catch(() => null);
    }
    if (!delivery) {
      throw DomainError.notFound('delivery not found');
    }
    return delivery;
  }

  private async getOwnDelivery(actor: Actor, deliveryId: string): Promise<DeliveryDocument> {
    this.ensureRole(actor, ROLE_COURIER);
    const delivery = await this.getOrThrow(deliveryId);
    if (delivery.livreurId !== actor.userId) {
      throw DomainError.forbidden('this delivery is assigned to another courier');
    }
    return delivery;
  }

  private ensureRole(actor: Actor, ...roles: string[]): void {
    if (!roles.some((r) => actor.roles.includes(r))) {
      throw DomainError.forbidden(`requires role: ${roles.join(' or ')}`);
    }
  }
}
