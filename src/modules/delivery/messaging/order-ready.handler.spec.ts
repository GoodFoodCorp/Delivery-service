import { DeliveryDocument } from '../entities/delivery.schema';
import { OrderReadyHandler } from './order-ready.handler';

const message = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      eventId: 'evt-1',
      type: 'order.ready_for_pickup',
      occurredAt: '2026-10-10T12:00:00Z',
      data: { orderId: 'o-1', customerId: 'c-1', restaurantId: 'r-1', deliveryAddress: '1 rue A' },
      ...overrides,
    }),
  );

function setup(created: boolean) {
  const delivery = { _id: 'd1' } as unknown as DeliveryDocument;
  const deliveries = { registerReadyOrder: jest.fn().mockResolvedValue({ delivery, created }) };
  const notifier = { notifyNewDelivery: jest.fn().mockResolvedValue(undefined) };
  const handler = new OrderReadyHandler(deliveries as never, notifier as never);
  return { deliveries, notifier, handler, delivery };
}

describe('OrderReadyHandler', () => {
  it('registers the order and notifies couriers when the delivery is new', async () => {
    const { deliveries, notifier, handler, delivery } = setup(true);

    await handler.handle(message());

    expect(deliveries.registerReadyOrder).toHaveBeenCalledWith({
      id: 'o-1',
      customer_id: 'c-1',
      restaurant_id: 'r-1',
      delivery_address: '1 rue A',
    });
    expect(notifier.notifyNewDelivery).toHaveBeenCalledWith(delivery);
  });

  it('does not notify again for a redelivered event', async () => {
    const { notifier, handler } = setup(false);

    await handler.handle(message());

    expect(notifier.notifyNewDelivery).not.toHaveBeenCalled();
  });

  it('throws on a malformed message so the consumer sends it to the DLQ', async () => {
    const { deliveries, handler } = setup(true);

    await expect(handler.handle(Buffer.from('garbage'))).rejects.toThrow();
    expect(deliveries.registerReadyOrder).not.toHaveBeenCalled();
  });

  it('still succeeds when notifying couriers fails', async () => {
    const { notifier, handler } = setup(true);
    notifier.notifyNewDelivery.mockRejectedValue(new Error('push down'));

    await expect(handler.handle(message())).resolves.toBeUndefined();
  });
});
