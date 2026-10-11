import { parseOrderReadyEvent } from './order-ready.event';

const valid = {
  eventId: 'evt-1',
  type: 'order.ready_for_pickup',
  occurredAt: '2026-10-10T12:00:00Z',
  data: { orderId: 'o-1', customerId: 'c-1', restaurantId: 'r-1', deliveryAddress: '12 rue de Paris' },
};

describe('parseOrderReadyEvent', () => {
  it('maps a valid message to a ReadyOrder', () => {
    expect(parseOrderReadyEvent(Buffer.from(JSON.stringify(valid)))).toEqual({
      id: 'o-1',
      customer_id: 'c-1',
      restaurant_id: 'r-1',
      delivery_address: '12 rue de Paris',
    });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseOrderReadyEvent(Buffer.from('not json'))).toThrow();
  });

  it('rejects a message with a missing field', () => {
    const broken = { ...valid, data: { ...valid.data, orderId: '' } };
    expect(() => parseOrderReadyEvent(Buffer.from(JSON.stringify(broken)))).toThrow(/orderId/);
  });

  it('rejects an unexpected event type', () => {
    const other = { ...valid, type: 'order.cancelled' };
    expect(() => parseOrderReadyEvent(Buffer.from(JSON.stringify(other)))).toThrow(/type/);
  });
});
