import { ReadyOrder } from '../orders.client';

export const ORDER_EVENTS_EXCHANGE = 'goodfood.events';
export const ORDER_READY_ROUTING_KEY = 'order.ready_for_pickup';
export const ORDER_CANCELLED_ROUTING_KEY = 'order.cancelled';
/** Keeps its historical name: it now receives every order event this service reacts to. */
export const ORDER_READY_QUEUE = 'delivery.order-ready';
export const ORDER_READY_DLQ = 'delivery.order-ready.dlq';
export const ORDER_ROUTING_KEYS = [ORDER_READY_ROUTING_KEY, ORDER_CANCELLED_ROUTING_KEY];

const REQUIRED_FIELDS = ['orderId', 'customerId', 'restaurantId'] as const;

export type OrderEvent =
  | { type: typeof ORDER_READY_ROUTING_KEY; order: ReadyOrder }
  | { type: typeof ORDER_CANCELLED_ROUTING_KEY; orderId: string };

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parses and validates an order event. Throws when invalid or unexpected. */
export function parseOrderEvent(raw: Buffer): OrderEvent {
  const message = JSON.parse(raw.toString('utf8')) as { type?: string; data?: Record<string, unknown> };
  const data = message?.data ?? {};
  if (typeof data.orderId !== 'string' || data.orderId === '') {
    throw new Error('missing field: orderId');
  }
  if (message.type === ORDER_CANCELLED_ROUTING_KEY) {
    return { type: ORDER_CANCELLED_ROUTING_KEY, orderId: data.orderId };
  }
  if (message.type !== ORDER_READY_ROUTING_KEY) {
    throw new Error(`unexpected event type: ${String(message?.type)}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof data[field] !== 'string' || data[field] === '') {
      throw new Error(`missing field: ${field}`);
    }
  }
  const fulfillment = typeof data.fulfillment === 'string' ? data.fulfillment : 'DELIVERY';
  if (fulfillment !== 'PICKUP' && (typeof data.deliveryAddress !== 'string' || data.deliveryAddress === '')) {
    throw new Error('missing field: deliveryAddress');
  }
  return {
    type: ORDER_READY_ROUTING_KEY,
    order: {
      id: data.orderId,
      customer_id: data.customerId as string,
      restaurant_id: data.restaurantId as string,
      delivery_address: (data.deliveryAddress as string) ?? '',
      fulfillment,
      dropoff_lat: optionalNumber(data.dropoffLat),
      dropoff_lng: optionalNumber(data.dropoffLng),
      tip_cents: optionalNumber(data.tipCents) ?? 0,
    },
  };
}

/** Kept for callers that only handle the ready event. */
export function parseOrderReadyEvent(raw: Buffer): ReadyOrder {
  const event = parseOrderEvent(raw);
  if (event.type !== ORDER_READY_ROUTING_KEY) {
    throw new Error(`unexpected event type: ${event.type}`);
  }
  return event.order;
}
