import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Actor } from '../../common/auth.util';
import { DomainError, DomainErrorCode } from '../../common/errors';
import { DELIVERY_REPOSITORY, DeliveryRepository, NearQuery } from './delivery.repository';
import {
  computeCourierFeeCents,
  distanceKm,
  estimateDeliveryTime,
  HANDOVER_MINUTES,
  liveEta,
  LiveEta,
  PICKUP_MINUTES,
  pseudoCoordinates,
} from './geo';
import { LatLng, locateOnRoute, PlannedRoute, remainingKm, ROUTE_PLANNER, RoutePlanner } from './routing';
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

/** Wrong handover codes allowed before the delivery needs the support team. */
const MAX_HANDOVER_ATTEMPTS = 5;

/** A courier's GPS point is stored at most this often (the live feed still gets every point). */
const POSITION_STORE_INTERVAL_MS = 3000;
/** The arrival time read by the order page is saved at most this often. */
const ETA_STORE_INTERVAL_MS = 30_000;

/** Where the courier's vehicle comes from (courier profiles). */
export interface VehicleLookup {
  vehicleOf(courierId: string): Promise<string | null>;
}

/** One live point of a delivery, as sent to whoever tracks it. */
export interface LivePosition extends LiveEta {
  deliveryId: string;
  lat: number;
  lng: number;
  timestamp: Date;
  status: DeliveryStatus;
  /** The road route left to ride, sent only when it was (re)planned. */
  route?: LatLng[];
}

/** The planned route of a delivery and what it was planned for. */
interface TrackedRoute {
  phase: LiveEta['phase'];
  route: PlannedRoute;
  plannedAt: number;
}

/** A courier this far from the route gets a new one (wrong turn, detour). */
const OFF_ROUTE_KM = 0.08;
/** Traffic changes: a route is replanned at least this often. */
const ROUTE_MAX_AGE_MS = 5 * 60_000;
const MAX_TRACKED_ROUTES = 20_000;

/** Deliveries a courier may carry at once (MAX_ACTIVE_DELIVERIES, default 2). */
export function maxActiveDeliveries(): number {
  const value = Number(process.env.MAX_ACTIVE_DELIVERIES);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

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
  private readonly lastStoredEta = new Map<string, number>();
  private readonly vehicleByCourier = new Map<string, string | null>();
  private readonly routes = new Map<string, TrackedRoute>();
  private readonly planning = new Map<string, Promise<TrackedRoute | null>>();

  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
    private readonly orders: OrdersClient,
    private readonly restaurants: RestaurantsClient,
    @Optional() @Inject('VEHICLE_LOOKUP') private readonly vehicles?: VehicleLookup,
    @Optional() @Inject(ROUTE_PLANNER) private readonly planner?: RoutePlanner,
  ) {}

  // ── Deliveries lifecycle ──────────────────────────────────

  /**
   * Creates the UNASSIGNED delivery of an order awaiting a courier. Idempotent:
   * shared by the order event consumer and the reconciliation job. Pickups
   * (click & collect) never get a delivery.
   */
  async registerReadyOrder(
    order: ReadyOrder,
  ): Promise<{ delivery: DeliveryDocument | null; created: boolean }> {
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

    const pickup = {
      address: restaurant?.address ?? `Restaurant ${order.restaurant_id.slice(0, 8)}`,
      ...pickupPoint,
    };
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
        handoverCode: randomInt(0, 10_000).toString().padStart(4, '0'),
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
    const active = await this.repo.listByCourier(actor.userId, ACTIVE_STATUSES);
    if (active.length >= maxActiveDeliveries()) {
      throw DomainError.conflict(
        `Terminez vos ${active.length} course(s) en cours avant d'en accepter une autre`,
      );
    }
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
    await this.advanceOrder(
      delivery,
      ORDER_IN_DELIVERY,
      actor.userId,
      requestId,
      'order is not ready for pickup yet',
    );
    const now = new Date();
    const eta = liveEta(
      delivery.pickup,
      delivery.pickup,
      delivery.dropoff,
      true,
      await this.vehicleOf(actor.userId),
      now,
    );
    return this.applyTransition(delivery, actor, [DeliveryStatus.Assigned], DeliveryStatus.PickedUp, {
      pickedUpAt: now,
      estimatedDeliveryTime: eta.etaAt,
    });
  }

  /**
   * Courier drops the order off (PICKED_UP/IN_TRANSIT → DELIVERED). The
   * customer's 4-digit handover code proves the meal reached them; after 5
   * wrong codes the delivery is locked for the support team.
   */
  async dropoff(
    actor: Actor,
    deliveryId: string,
    code?: string,
    requestId?: string,
  ): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    const from = [DeliveryStatus.PickedUp, DeliveryStatus.InTransit];
    if (!from.includes(delivery.status)) {
      throw DomainError.conflict(`cannot drop off a delivery in status ${delivery.status}`);
    }
    await this.checkHandoverCode(delivery, code);
    await this.advanceOrder(
      delivery,
      ORDER_DELIVERED,
      actor.userId,
      requestId,
      'order cannot be marked delivered',
    );
    this.routes.delete(String(delivery._id));
    return this.applyTransition(delivery, actor, from, DeliveryStatus.Delivered, { deliveredAt: new Date() });
  }

  /** The customer rates a delivered delivery, once. */
  async rate(actor: Actor, deliveryId: string, rating: number, comment = ''): Promise<DeliveryDocument> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw DomainError.validation('rating must be an integer from 1 to 5');
    }
    const delivery = await this.getOrThrow(deliveryId);
    if (delivery.customerId !== actor.userId) {
      throw DomainError.forbidden('only the customer can rate this delivery');
    }
    const rated = await this.repo.rate(
      String(delivery._id),
      actor.userId,
      rating,
      comment.trim().slice(0, 500),
      new Date(),
    );
    if (!rated) {
      throw DomainError.conflict('only a delivered delivery can be rated, once');
    }
    return rated;
  }

  /** Average rating of a courier, shown in their earnings screen. */
  ratingOf(courierId: string) {
    return this.repo.ratingOf(courierId);
  }

  // ── Reads ─────────────────────────────────────────────────

  /** Detail + last known position: the customer, the assigned courier, the restaurant's manager or admin. */
  async getById(actor: Actor, deliveryId: string) {
    const delivery = await this.getOrThrow(deliveryId);
    if (!this.isAllowedToWatch(actor, delivery)) {
      throw DomainError.forbidden('you are not allowed to view this delivery');
    }
    const last = await this.repo.lastPosition(String(delivery._id));
    // The handover code is the customer's to give: never shown to the courier.
    const handoverCode =
      delivery.customerId === actor.userId ? await this.repo.handoverCodeOf(String(delivery._id)) : undefined;
    return {
      delivery,
      lastPosition: last ? { lat: last.lat, lng: last.lng, timestamp: last.timestamp } : null,
      ...(handoverCode ? { handoverCode } : {}),
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
  /**
   * A GPS point of the courier, from acceptance (on the way to the
   * restaurant) to drop-off. The arrival time is recomputed from it each time
   * and sent with the point; it is saved now and then for the order page.
   */
  async recordPosition(actor: Actor, deliveryId: string, lat: number, lng: number): Promise<LivePosition> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    const tracked = [DeliveryStatus.Assigned, DeliveryStatus.PickedUp, DeliveryStatus.InTransit];
    if (!tracked.includes(delivery.status)) {
      throw DomainError.conflict('position updates are only accepted during an active delivery');
    }
    let status = delivery.status;
    if (status === DeliveryStatus.PickedUp) {
      await this.repo.transition(
        String(delivery._id),
        actor.userId,
        [DeliveryStatus.PickedUp],
        DeliveryStatus.InTransit,
      );
      status = DeliveryStatus.InTransit;
    }
    const timestamp = new Date();
    const id = String(delivery._id);
    if (timestamp.getTime() - (this.lastStoredPosition.get(id) ?? 0) >= POSITION_STORE_INTERVAL_MS) {
      await this.repo.addPosition(id, lat, lng, timestamp);
      this.lastStoredPosition.set(id, timestamp.getTime());
    }
    const vehicle = await this.vehicleOf(actor.userId);
    const pickedUp = status !== DeliveryStatus.Assigned;
    const { tracked: onRoute, replanned } = await this.routeFor(delivery, { lat, lng }, pickedUp, vehicle);
    const eta = onRoute
      ? etaOnRoute(onRoute, { lat, lng }, pickedUp, timestamp)
      : liveEta({ lat, lng }, delivery.pickup, delivery.dropoff, pickedUp, vehicle, timestamp);
    if (timestamp.getTime() - (this.lastStoredEta.get(id) ?? 0) >= ETA_STORE_INTERVAL_MS) {
      await this.repo.transition(id, actor.userId, [status], status, { estimatedDeliveryTime: eta.etaAt });
      this.lastStoredEta.set(id, timestamp.getTime());
    }
    return {
      deliveryId: id,
      lat,
      lng,
      timestamp,
      status,
      ...eta,
      ...(replanned && onRoute ? { route: onRoute.route.path } : {}),
    };
  }

  /**
   * The road route the courier follows: through the restaurant before the
   * pickup, straight to the customer after. Kept per delivery and planned
   * again on a new phase, a detour or when it gets old. One planning at a
   * time per delivery; without a planner (or when it fails) there is none.
   */
  private async routeFor(
    delivery: DeliveryDocument,
    at: { lat: number; lng: number },
    pickedUp: boolean,
    vehicle: string | null,
  ): Promise<{ tracked: TrackedRoute | null; replanned: boolean }> {
    if (!this.planner) return { tracked: null, replanned: false };
    const id = String(delivery._id);
    const phase: LiveEta['phase'] = pickedUp ? 'TO_CUSTOMER' : 'TO_RESTAURANT';
    const current = this.routes.get(id);
    const fresh =
      current &&
      current.phase === phase &&
      Date.now() - current.plannedAt < ROUTE_MAX_AGE_MS &&
      locateOnRoute(current.route.path, at).offKm <= OFF_ROUTE_KM;
    if (fresh) return { tracked: current, replanned: false };

    let pending = this.planning.get(id);
    if (!pending) {
      const stops = pickedUp ? [at, delivery.dropoff] : [at, delivery.pickup, delivery.dropoff];
      pending = this.planner
        .route(stops, vehicle)
        .then((route) => (route ? { phase, route, plannedAt: Date.now() } : null))
        .finally(() => this.planning.delete(id));
      this.planning.set(id, pending);
    }
    const planned = await pending;
    if (!planned) return { tracked: current?.phase === phase ? current : null, replanned: false };
    if (this.routes.size > MAX_TRACKED_ROUTES) this.routes.clear();
    this.routes.set(id, planned);
    return { tracked: planned, replanned: true };
  }

  /**
   * The route left to ride, for a page opened during the delivery (the live
   * feed only sends a route when it changes).
   */
  async routeOf(actor: Actor, deliveryId: string) {
    const delivery = await this.getOrThrow(deliveryId);
    if (!this.isAllowedToWatch(actor, delivery)) {
      throw DomainError.forbidden('you are not allowed to view this delivery');
    }
    const id = String(delivery._id);
    const riding = [DeliveryStatus.Assigned, DeliveryStatus.PickedUp, DeliveryStatus.InTransit];
    if (!riding.includes(delivery.status)) return { route: null };
    const pickedUp = delivery.status !== DeliveryStatus.Assigned;
    const last = await this.repo.lastPosition(id);
    const at = last ? { lat: last.lat, lng: last.lng } : delivery.pickup;
    const vehicle = delivery.livreurId ? await this.vehicleOf(delivery.livreurId) : null;
    const { tracked: route } = await this.routeFor(delivery, at, pickedUp, vehicle);
    if (!route) return { route: null };
    return { route: route.route.path, ...etaOnRoute(route, at, pickedUp, new Date()) };
  }

  private async vehicleOf(courierId: string): Promise<string | null> {
    if (!this.vehicles) return null;
    if (!this.vehicleByCourier.has(courierId)) {
      if (this.vehicleByCourier.size > 10_000) this.vehicleByCourier.clear();
      this.vehicleByCourier.set(courierId, await this.vehicles.vehicleOf(courierId).catch(() => null));
    }
    return this.vehicleByCourier.get(courierId) ?? null;
  }

  /** What couriers are told about a new delivery (no customer data). */
  toAvailableView(
    d: DeliveryDocument | (Delivery & { _id: unknown; createdAt?: Date }),
  ): AvailableDeliveryView {
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

  private async checkHandoverCode(delivery: DeliveryDocument, code?: string): Promise<void> {
    const expected = await this.repo.handoverCodeOf(String(delivery._id));
    if (!expected) return; // deliveries created before handover codes existed
    if ((delivery.handoverAttempts ?? 0) >= MAX_HANDOVER_ATTEMPTS) {
      throw DomainError.forbidden('too many wrong codes: contact support to close this delivery');
    }
    if (code?.trim() !== expected) {
      const attempts = await this.repo.recordHandoverAttempt(String(delivery._id));
      throw DomainError.validation(
        `wrong handover code (${MAX_HANDOVER_ATTEMPTS - attempts} attempt(s) left)`,
      );
    }
  }

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

/** Arrival time from where the courier is on the planned route. */
function etaOnRoute(
  tracked: TrackedRoute,
  at: { lat: number; lng: number },
  pickedUp: boolean,
  now: Date,
): LiveEta {
  const { route } = tracked;
  const { index } = locateOnRoute(route.path, at);
  const left = remainingKm(route.path, index);
  const share = route.distanceKm > 0 ? Math.min(1, left / route.distanceKm) : 0;
  const minutes = route.durationMin * share + HANDOVER_MINUTES + (pickedUp ? 0 : PICKUP_MINUTES);
  return {
    etaAt: new Date(now.getTime() + minutes * 60_000),
    remainingKm: Math.round(left * 10) / 10,
    phase: pickedUp ? 'TO_CUSTOMER' : 'TO_RESTAURANT',
  };
}
