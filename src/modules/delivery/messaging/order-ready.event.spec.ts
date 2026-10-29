import { parseOrderEvent, parseOrderReadyEvent } from './order-ready.event';

const valid = {
  eventId: 'evt-1',
  type: 'order.ready_for_pickup',
  occurredAt: '2026-10-10T12:00:00Z',
  data: {
    orderId: 'o-1',
    customerId: 'c-1',
    restaurantId: 'r-1',
    deliveryAddress: '12 rue de Paris',
    fulfillment: 'DELIVERY',
    dropoffLat: 48.86,
    dropoffLng: 2.36,
    tipCents: 200,
  },
};

const buf = (v: unknown) => Buffer.from(JSON.stringify(v));

describe('parseOrderEvent', () => {
  it('maps a ready event with its drop-off position and tip', () => {
    expect(parseOrderReadyEvent(buf(valid))).toEqual({
      id: 'o-1',
      customer_id: 'c-1',
      restaurant_id: 'r-1',
      delivery_address: '12 rue de Paris',
      fulfillment: 'DELIVERY',
      dropoff_lat: 48.86,
      dropoff_lng: 2.36,
      tip_cents: 200,
    });
  });

  it('accepts events from older order-service versions (no position, no fulfillment)', () => {
    const legacy = { ...valid, data: { orderId: 'o-1', customerId: 'c-1', restaurantId: 'r-1', deliveryAddress: 'x' } };
    expect(parseOrderReadyEvent(buf(legacy))).toMatchObject({ fulfillment: 'DELIVERY', dropoff_lat: null, tip_cents: 0 });
  });

  it('maps a cancellation', () => {
    expect(parseOrderEvent(buf({ type: 'order.cancelled', data: { orderId: 'o-1' } }))).toEqual({
      type: 'order.cancelled',
      orderId: 'o-1',
    });
  });

  it('accepts a pickup without delivery address', () => {
    const pickup = { ...valid, data: { ...valid.data, fulfillment: 'PICKUP', deliveryAddress: '' } };
    expect(parseOrderReadyEvent(buf(pickup)).fulfillment).toBe('PICKUP');
  });

  it('rejects invalid JSON, missing fields and unexpected types', () => {
    expect(() => parseOrderEvent(Buffer.from('not json'))).toThrow();
    expect(() => parseOrderEvent(buf({ ...valid, data: { ...valid.data, orderId: '' } }))).toThrow(/orderId/);
    expect(() => parseOrderEvent(buf({ ...valid, data: { ...valid.data, deliveryAddress: '' } }))).toThrow(/deliveryAddress/);
    expect(() => parseOrderEvent(buf({ ...valid, type: 'order.confirmed' }))).toThrow(/type/);
  });
});
