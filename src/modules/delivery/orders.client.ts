import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../common/errors';

export interface ReadyOrder {
  id: string;
  customer_id: string;
  restaurant_id: string;
  delivery_address: string;
}

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

  async listReadyForDelivery(bearerToken: string, requestId?: string): Promise<ReadyOrder[]> {
    const res = await fetch(`${this.baseUrl}/ready-for-delivery`, {
      headers: this.headers(bearerToken, requestId),
    });
    if (!res.ok) {
      throw DomainError.conflict(`order-service replied ${res.status} on ready-for-delivery`);
    }
    return (await res.json()) as ReadyOrder[];
  }

  /** Marks the order IN_DELIVERY / DELIVERED. Failures are logged but do not
   *  break the delivery flow (order status can be reconciled later). */
  async updateOrderStatus(
    orderId: string,
    status: string,
    bearerToken: string,
    requestId?: string,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/${orderId}/status`, {
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
