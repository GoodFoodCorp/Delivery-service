import { Inject, Injectable, Logger } from '@nestjs/common';
import { Actor } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { DELIVERY_REPOSITORY, DeliveryRepository } from './delivery.repository';
import { estimateDeliveryTime, pseudoCoordinates } from './geo';
import { OrdersClient } from './orders.client';
import { DeliveryDocument, DeliveryStatus } from './entities/delivery.schema';

const ROLE_COURIER = 'livreur';
const ROLE_ADMIN = 'admin';
const ROLE_MANAGER = 'manager';

/** Business logic and orchestration — no HTTP/WS concern in here. */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
    private readonly orders: OrdersClient,
  ) {}

  /**
   * Lists deliveries a courier can accept. First syncs from order-service:
   * every READY_FOR_PICKUP order without a delivery gets one (UNASSIGNED),
   * reusing the caller's own token (sync REST, see root README).
   */
  async listAvailable(actor: Actor, requestId?: string): Promise<DeliveryDocument[]> {
    this.ensureRole(actor, ROLE_COURIER, ROLE_ADMIN);

    try {
      const ready = await this.orders.listReadyForDelivery(actor.token, requestId);
      for (const order of ready) {
        if (!(await this.repo.findByOrderId(order.id))) {
          const pickup = { address: `Restaurant ${order.restaurant_id.slice(0, 8)}`, ...pseudoCoordinates(order.restaurant_id) };
          const dropoff = { address: order.delivery_address, ...pseudoCoordinates(order.id) };
          await this.repo.create({
            orderId: order.id,
            customerId: order.customer_id,
            restaurantId: order.restaurant_id,
            status: DeliveryStatus.Unassigned,
            pickup,
            dropoff,
            estimatedDeliveryTime: estimateDeliveryTime(pickup, dropoff),
          });
        }
      }
    } catch (err) {
      // Sync is best-effort: existing deliveries stay listable when
      // order-service is briefly unreachable.
      this.logger.warn(`sync with order-service failed: ${(err as Error).message}`);
    }

    return this.repo.listByStatus(DeliveryStatus.Unassigned);
  }

  /** Courier takes the delivery (UNASSIGNED → ASSIGNED) and the order goes IN_DELIVERY. */
  async accept(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    this.ensureRole(actor, ROLE_COURIER);
    const delivery = await this.getOrThrow(deliveryId);
    if (delivery.status !== DeliveryStatus.Unassigned) {
      throw DomainError.conflict('this delivery is already assigned');
    }
    delivery.livreurId = actor.userId;
    delivery.status = DeliveryStatus.Assigned;
    delivery.assignedAt = new Date();
    const saved = await this.repo.save(delivery);
    await this.orders.updateOrderStatus(delivery.orderId, 'IN_DELIVERY', actor.token, requestId);
    return saved;
  }

  /** Courier picked the order up at the restaurant (ASSIGNED → PICKED_UP). */
  async pickup(actor: Actor, deliveryId: string): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    if (delivery.status !== DeliveryStatus.Assigned) {
      throw DomainError.conflict(`cannot pick up a delivery in status ${delivery.status}`);
    }
    delivery.status = DeliveryStatus.PickedUp;
    delivery.pickedUpAt = new Date();
    return this.repo.save(delivery);
  }

  /** Courier drops the order off (PICKED_UP/IN_TRANSIT → DELIVERED, timestamped). */
  async dropoff(actor: Actor, deliveryId: string, requestId?: string): Promise<DeliveryDocument> {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    if (delivery.status !== DeliveryStatus.PickedUp && delivery.status !== DeliveryStatus.InTransit) {
      throw DomainError.conflict(`cannot drop off a delivery in status ${delivery.status}`);
    }
    delivery.status = DeliveryStatus.Delivered;
    delivery.deliveredAt = new Date();
    const saved = await this.repo.save(delivery);
    await this.orders.updateOrderStatus(delivery.orderId, 'DELIVERED', actor.token, requestId);
    return saved;
  }

  /** Detail + last known position; owner, courier, restaurant manager or admin. */
  async getById(actor: Actor, deliveryId: string) {
    const delivery = await this.getOrThrow(deliveryId);
    const allowed =
      actor.roles.includes(ROLE_ADMIN) ||
      actor.roles.includes(ROLE_COURIER) ||
      delivery.customerId === actor.userId ||
      (actor.roles.includes(ROLE_MANAGER) && actor.tenantId === delivery.restaurantId);
    if (!allowed) {
      throw DomainError.forbidden('you are not allowed to view this delivery');
    }
    const last = await this.repo.lastPosition(deliveryId);
    return {
      delivery,
      lastPosition: last ? { lat: last.lat, lng: last.lng, timestamp: last.timestamp } : null,
    };
  }

  /** Stores a courier GPS point; first point flips PICKED_UP → IN_TRANSIT. */
  async recordPosition(actor: Actor, deliveryId: string, lat: number, lng: number) {
    const delivery = await this.getOwnDelivery(actor, deliveryId);
    if (delivery.status !== DeliveryStatus.PickedUp && delivery.status !== DeliveryStatus.InTransit) {
      throw DomainError.conflict('position updates are only accepted during an active delivery');
    }
    if (delivery.status === DeliveryStatus.PickedUp) {
      delivery.status = DeliveryStatus.InTransit;
      await this.repo.save(delivery);
    }
    const timestamp = new Date();
    await this.repo.addPosition(deliveryId, lat, lng, timestamp);
    return { deliveryId, lat, lng, timestamp, status: delivery.status };
  }

  /** Access check for subscribing to a delivery's live tracking feed. */
  async canWatch(actor: Actor, deliveryId: string): Promise<boolean> {
    const delivery = await this.repo.findById(deliveryId);
    if (!delivery) {
      return false;
    }
    return (
      actor.roles.includes(ROLE_ADMIN) ||
      delivery.customerId === actor.userId ||
      delivery.livreurId === actor.userId ||
      (actor.roles.includes(ROLE_MANAGER) && actor.tenantId === delivery.restaurantId)
    );
  }

  private async getOrThrow(id: string): Promise<DeliveryDocument> {
    let delivery: DeliveryDocument | null = null;
    try {
      delivery = await this.repo.findById(id);
    } catch {
    }
    if (!delivery) {
      try {
        delivery = await this.repo.findByOrderId(id);
      } catch {
        throw DomainError.notFound('delivery not found');
      }
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
