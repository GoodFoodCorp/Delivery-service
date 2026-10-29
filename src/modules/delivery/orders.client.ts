import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors';

/** An order a courier may run, as order-service describes it. */
export interface ReadyOrder {
  id: string;
  customer_id: string;
  restaurant_id: string;
  delivery_address: string;
  status?: string;
  fulfillment?: string;
  dropoff_lat?: number | null;
  dropoff_lng?: number | null;
  courier_id?: string | null;
  tip_cents?: number;
}

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Client of order-service's internal API (X-Service-Key). Couriers never call
 * order-service themselves: this service decides which courier runs which
 * delivery and acts on the order on their behalf.
 */
@Injectable()
export class OrdersClient {
  private get baseUrl(): string {
    return (process.env.ORDER_SERVICE_URL ?? 'http://order-service:8082').replace(/\/+$/, '');
  }

  /** Deliveries awaiting a courier (no pickups, no already-claimed order). */
  listAwaitingCourier(requestId?: string): Promise<ReadyOrder[]> {
    return this.call<ReadyOrder[]>('GET', '/internal/orders/ready-for-delivery', undefined, requestId);
  }

  getOrder(orderId: string, requestId?: string): Promise<ReadyOrder> {
    return this.call<ReadyOrder>('GET', `/internal/orders/${encodeURIComponent(orderId)}`, undefined, requestId);
  }

  /** Records the courier on the order; a conflict means another courier holds it. */
  async assignCourier(orderId: string, courierId: string, requestId?: string): Promise<void> {
    await this.call('PUT', `/internal/orders/${encodeURIComponent(orderId)}/courier`, { courier_id: courierId }, requestId);
  }

  async unassignCourier(orderId: string, courierId: string, requestId?: string): Promise<void> {
    await this.call(
      'DELETE',
      `/internal/orders/${encodeURIComponent(orderId)}/courier/${encodeURIComponent(courierId)}`,
      undefined,
      requestId,
    );
  }

  /** Applies IN_DELIVERY / DELIVERED with the courier rules of order-service. */
  async updateOrderStatus(orderId: string, status: string, courierId: string, requestId?: string): Promise<void> {
    await this.call(
      'PATCH',
      `/internal/orders/${encodeURIComponent(orderId)}/status`,
      { status, courier_id: courierId },
      requestId,
    );
  }

  /** Maps order-service answers to domain errors; network failures are conflicts (retry later). */
  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = { 'X-Service-Key': process.env.SERVICE_API_KEY ?? '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['X-Request-ID'] = requestId;

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw DomainError.conflict(`order-service unreachable: ${(err as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return payload as T;
    const message = payload.error ?? `order-service replied ${res.status}`;
    if (res.status === 404) throw DomainError.notFound(message);
    if (res.status === 403) throw DomainError.forbidden(message);
    if (res.status === 400) throw DomainError.validation(message);
    throw DomainError.conflict(message);
  }
}
