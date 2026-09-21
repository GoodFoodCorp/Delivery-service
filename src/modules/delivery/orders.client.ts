import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../common/errors';

export interface ReadyOrder {
  id: string;
  customer_id: string;
  restaurant_id: string;
  delivery_address: string;
  /** Order lifecycle status, mirrored from order-service. */
  status: string;
}

/** The only order status from which a courier may collect the meal. */
export const ORDER_READY_FOR_PICKUP = 'READY_FOR_PICKUP';

/**
 * Synchronous REST client to order-service (see root README: sync
 * communication for the POC, event bus as future evolution).
 * The caller's own JWT is forwarded — no service account needed.
 */
@Injectable()
export class OrdersClient {
  private readonly logger = new Logger(OrdersClient.name);

  private get baseUrl(): string {
    return process.env.ORDER_SERVICE_URL ?? 'http://order-service:8082';
  }

  /** Orders a courier may claim — still IN_PREPARATION, or READY_FOR_PICKUP. */
  async listReadyForDelivery(bearerToken: string, requestId?: string): Promise<ReadyOrder[]> {
    const res = await fetch(`${this.baseUrl}/api/orders/ready-for-delivery`, {
      headers: this.headers(bearerToken, requestId),
    });
    if (!res.ok) {
      throw DomainError.conflict(`order-service replied ${res.status} on ready-for-delivery`);
    }
    return (await res.json()) as ReadyOrder[];
  }

  /**
   * Reads one order. Unlike updateOrderStatus this one throws: it backs the
   * pickup guard, where an unknown order status must block the pickup rather
   * than let a courier collect a meal that may not be cooked.
   */
  async getOrder(orderId: string, bearerToken: string, requestId?: string): Promise<ReadyOrder> {
    const res = await fetch(`${this.baseUrl}/api/orders/${orderId}`, {
      headers: this.headers(bearerToken, requestId),
    });
    if (!res.ok) {
      throw DomainError.conflict(`order-service replied ${res.status} for order ${orderId}`);
    }
    return (await res.json()) as ReadyOrder;
  }

  /** Marks the order IN_DELIVERY / DELIVERED. Failures are logged but do not
   *  break the delivery flow (order status can be reconciled later). */
  async updateOrderStatus(orderId: string, status: string, bearerToken: string, requestId?: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { ...this.headers(bearerToken, requestId), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        this.logger.warn(`order-service replied ${res.status} when setting order ${orderId} to ${status}`);
      }
    } catch (err) {
      this.logger.warn(`could not reach order-service for order ${orderId}: ${(err as Error).message}`);
    }
  }

  private headers(bearerToken: string, requestId?: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${bearerToken}` };
    if (requestId) {
      h['X-Request-ID'] = requestId;
    }
    return h;
  }
}
