import { ReadyOrder } from '../orders.client';

export const ORDER_EVENTS_EXCHANGE = 'goodfood.events';
export const ORDER_READY_ROUTING_KEY = 'order.ready_for_pickup';
export const ORDER_READY_QUEUE = 'delivery.order-ready';
export const ORDER_READY_DLQ = 'delivery.order-ready.dlq';

const REQUIRED_FIELDS = ['orderId', 'customerId', 'restaurantId', 'deliveryAddress'] as const;

/** Parses and validates an order.ready_for_pickup message. Throws when invalid. */
export function parseOrderReadyEvent(raw: Buffer): ReadyOrder {
  const message = JSON.parse(raw.toString('utf8')) as {
    type?: string;
    data?: Record<string, unknown>;
  };
  if (message?.type !== ORDER_READY_ROUTING_KEY) {
    throw new Error(`unexpected event type: ${String(message?.type)}`);
  }
  const data = message.data ?? {};
  for (const field of REQUIRED_FIELDS) {
    if (typeof data[field] !== 'string' || data[field] === '') {
      throw new Error(`missing field: ${field}`);
    }
  }
  return {
    id: data.orderId as string,
    customer_id: data.customerId as string,
    restaurant_id: data.restaurantId as string,
    delivery_address: data.deliveryAddress as string,
  };
}
