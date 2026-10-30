import { courierAssignedNotifications, orderNotifications } from './order-notifications';

const event = (type: string, data: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      id: 'evt-1',
      type,
      occurredAt: '2026-10-31T10:00:00Z',
      data: { orderId: 'abcdef1234', customerId: 'cust', restaurantId: 'resto', ...data },
    }),
  );

const who = (list: ReturnType<typeof orderNotifications>) =>
  list.map((n) => `${n.target.kind}:${n.notification.title}`);

describe('orderNotifications', () => {
  it('tells the customer and the restaurant about a new order', () => {
    const list = orderNotifications(
      event('order.confirmed', { amountDueCents: 2378, fulfillment: 'DELIVERY' }),
    );
    expect(who(list)).toEqual(['user:Commande confirmée', 'restaurant:Nouvelle commande']);
    expect(list[1].notification.body).toBe('#abcdef12 · 23,78 € · Livraison');
    expect(list[0].notification.link).toBe('/orders/abcdef1234');
  });

  it('tells the courier the meal is ready, and the customer of a pickup to come', () => {
    expect(who(orderNotifications(event('order.ready_for_pickup', { courierId: 'liv' })))).toEqual([
      'user:Commande prête',
      'courier:Commande prête',
    ]);
    expect(who(orderNotifications(event('order.ready_for_pickup', { fulfillment: 'PICKUP' })))).toEqual([
      'user:Votre commande est prête',
    ]);
  });

  it('does not tell people what they did themselves', () => {
    expect(who(orderNotifications(event('order.cancelled', { cancelledBy: 'CUSTOMER' })))).toEqual([
      'restaurant:Commande annulée',
    ]);
    expect(
      who(orderNotifications(event('order.cancelled', { cancelledBy: 'RESTAURANT', courierId: 'liv' }))),
    ).toEqual(['user:Commande annulée', 'courier:Course annulée']);
  });

  it('ignores events nobody needs and unreadable ones', () => {
    expect(orderNotifications(event('order.payment_pending', {}))).toEqual([]);
    expect(orderNotifications(Buffer.from(JSON.stringify({ type: 'stock.low' })))).toEqual([]);
    expect(() => orderNotifications(Buffer.from('not json'))).toThrow();
  });

  it('tells the customer and the restaurant a courier took the order', () => {
    expect(courierAssignedNotifications('abcdef1234', 'cust', 'resto').map((n) => n.target)).toEqual([
      { kind: 'user', id: 'cust' },
      { kind: 'restaurant', id: 'resto' },
    ]);
  });
});
