import { DeliveryGateway } from './delivery.gateway';
import { DeliveryDocument } from './entities/delivery.schema';

describe('DeliveryGateway availability', () => {
  it('emits delivery:available to the couriers room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = new DeliveryGateway({} as never);
    gateway.server = { to } as never;
    const delivery = { _id: 'd1' } as unknown as DeliveryDocument;

    gateway.emitAvailable(delivery);

    expect(to).toHaveBeenCalledWith('couriers');
    expect(emit).toHaveBeenCalledWith('delivery:available', delivery);
  });
});
