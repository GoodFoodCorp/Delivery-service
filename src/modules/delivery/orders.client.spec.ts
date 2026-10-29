import { DomainErrorCode } from '../../common/errors';
import { OrdersClient } from './orders.client';

function respond(status: number, body: unknown = {}) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('OrdersClient', () => {
  beforeEach(() => {
    process.env.ORDER_SERVICE_URL = 'http://order-service:80/';
    process.env.SERVICE_API_KEY = 'svc-key';
  });
  afterEach(() => jest.restoreAllMocks());

  it('acts on the order through the internal API with the service key', async () => {
    const fetchMock = respond(200, {});

    await new OrdersClient().updateOrderStatus('o1', 'IN_DELIVERY', 'liv-1', 'req-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://order-service:80/internal/orders/o1/status');
    expect(init!.method).toBe('PATCH');
    expect((init!.headers as Record<string, string>)['X-Service-Key']).toBe('svc-key');
    expect((init!.headers as Record<string, string>)['X-Request-ID']).toBe('req-1');
    expect(JSON.parse(init!.body as string)).toEqual({ status: 'IN_DELIVERY', courier_id: 'liv-1' });
  });

  it.each([
    [404, DomainErrorCode.NotFound],
    [403, DomainErrorCode.Forbidden],
    [409, DomainErrorCode.Conflict],
    [503, DomainErrorCode.Conflict],
  ])('maps a %i to %s', async (status, code) => {
    respond(status, { error: 'nope' });
    await expect(new OrdersClient().assignCourier('o1', 'liv-1')).rejects.toMatchObject({ code, message: 'nope' });
  });

  it('turns a network failure into a conflict', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new OrdersClient().listAwaitingCourier()).rejects.toMatchObject({ code: DomainErrorCode.Conflict });
  });
});
