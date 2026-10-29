import { DeliveryGateway } from './delivery.gateway';
import { AvailableDeliveryView } from './delivery.service';
import { DeliveryDocument } from './entities/delivery.schema';

function gatewayWithSpy() {
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  const gateway = new DeliveryGateway({} as never);
  gateway.server = { to } as never;
  return { gateway, to, emit };
}

describe('DeliveryGateway', () => {
  it('emits delivery:available to the couriers room', () => {
    const { gateway, to, emit } = gatewayWithSpy();
    const view = { id: 'd1' } as AvailableDeliveryView;

    gateway.emitAvailable(view);

    expect(to).toHaveBeenCalledWith('couriers');
    expect(emit).toHaveBeenCalledWith('delivery:available', view);
  });

  it('tells the assigned courier and the watchers about a cancellation', () => {
    const { gateway, to, emit } = gatewayWithSpy();

    gateway.emitCancelled({ _id: 'd1', orderId: 'o1', livreurId: 'liv-1' } as unknown as DeliveryDocument);

    expect(to).toHaveBeenCalledWith(['delivery:d1', 'courier:liv-1']);
    expect(emit).toHaveBeenCalledWith('delivery:cancelled', { deliveryId: 'd1', orderId: 'o1' });
  });

  it('withdraws an unassigned cancelled delivery from every courier list', () => {
    const { gateway, to } = gatewayWithSpy();

    gateway.emitCancelled({ _id: 'd1', orderId: 'o1', livreurId: null } as unknown as DeliveryDocument);

    expect(to).toHaveBeenCalledWith('couriers');
  });
});
