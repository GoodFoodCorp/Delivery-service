import { DeliveryDocument } from './entities/delivery.schema';
import { PushService } from './push.service';

const delivery = {
  _id: 'd1',
  pickup: { address: 'Restaurant r1', lat: 0, lng: 0 },
} as unknown as DeliveryDocument;

function setup(targets: { userId: string; pushToken: string }[], busy: string[] = []) {
  const profiles = {
    listPushTargets: jest.fn().mockResolvedValue(targets),
    clearPushTokens: jest.fn().mockResolvedValue(undefined),
  };
  const repo = { listActiveCourierIds: jest.fn().mockResolvedValue(busy) };
  const service = new PushService(profiles as never, repo as never);
  return { profiles, repo, service };
}

function mockExpo(tickets: unknown[]) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ data: tickets }),
  } as Response);
}

afterEach(() => jest.restoreAllMocks());

describe('PushService.notifyNewDelivery', () => {
  it('sends one push per available courier', async () => {
    const fetchMock = mockExpo([{ status: 'ok' }, { status: 'ok' }]);
    const { service } = setup([
      { userId: 'liv-1', pushToken: 'ExponentPushToken[a]' },
      { userId: 'liv-2', pushToken: 'ExponentPushToken[b]' },
    ]);

    await service.notifyNewDelivery(delivery);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    const messages = JSON.parse((init as RequestInit).body as string);
    expect(messages.map((m: { to: string }) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(messages[0]).toMatchObject({
      title: 'Nouvelle commande disponible',
      data: { screen: 'delivery-home', deliveryId: 'd1' },
    });
  });

  it('skips couriers who already have an active delivery', async () => {
    const fetchMock = mockExpo([{ status: 'ok' }]);
    const { service } = setup(
      [
        { userId: 'liv-1', pushToken: 'ExponentPushToken[a]' },
        { userId: 'liv-2', pushToken: 'ExponentPushToken[b]' },
      ],
      ['liv-1'],
    );

    await service.notifyNewDelivery(delivery);

    const messages = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(messages.map((m: { to: string }) => m.to)).toEqual(['ExponentPushToken[b]']);
  });

  it('does not call Expo when nobody is eligible', async () => {
    const fetchMock = mockExpo([]);
    const { service } = setup([{ userId: 'liv-1', pushToken: 'ExponentPushToken[a]' }], ['liv-1']);

    await service.notifyNewDelivery(delivery);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears tokens that Expo reports as DeviceNotRegistered', async () => {
    mockExpo([{ status: 'error', details: { error: 'DeviceNotRegistered' } }, { status: 'ok' }]);
    const { profiles, service } = setup([
      { userId: 'liv-1', pushToken: 'ExponentPushToken[gone]' },
      { userId: 'liv-2', pushToken: 'ExponentPushToken[ok]' },
    ]);

    await service.notifyNewDelivery(delivery);

    expect(profiles.clearPushTokens).toHaveBeenCalledWith(['ExponentPushToken[gone]']);
  });

  it('does not throw when the Expo API is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
    const { service } = setup([{ userId: 'liv-1', pushToken: 'ExponentPushToken[a]' }]);

    await expect(service.notifyNewDelivery(delivery)).resolves.toBeUndefined();
  });
});
