import * as jwt from 'jsonwebtoken';
import { isAllowedOrigin } from '../../common/origins';
import { DeliveryGateway } from './delivery.gateway';

type Middleware = (socket: unknown, next: (err?: Error) => void) => void;

const SECRET = 'test-secret';

function handshakeMiddleware(): Middleware {
  let mw: Middleware | undefined;
  new DeliveryGateway({} as never).afterInit({ use: (fn: Middleware) => (mw = fn) } as never);
  return mw!;
}

function socket(headers: Record<string, string>, auth: Record<string, string> = {}) {
  return { handshake: { headers, auth }, data: {} as { actor?: { userId: string } } };
}

function run(s: ReturnType<typeof socket>): Error | undefined {
  let result: Error | undefined;
  handshakeMiddleware()(s, (err) => (result = err));
  return result;
}

const token = (claims: Record<string, unknown>) =>
  jwt.sign({ typ: 'access', sub: 'u1', role_slugs: ['user'], ...claims }, SECRET, {
    algorithm: 'HS256',
    issuer: 'goodfood-auth',
    audience: 'goodfood-api',
    expiresIn: 60,
  });

describe('DeliveryGateway handshake', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    delete process.env.ALLOWED_ORIGINS;
  });

  it('lets a page of this site in with its session cookie', () => {
    const s = socket({ origin: 'https://app.example', host: 'app.example', cookie: `auth_token=${token({})}` });
    expect(run(s)).toBeUndefined();
    expect(s.data.actor?.userId).toBe('u1');
  });

  it('refuses another site, even with the victim’s cookie (cross-site hijacking)', () => {
    const s = socket({ origin: 'https://evil.example', host: 'app.example', cookie: `auth_token=${token({})}` });
    expect(run(s)?.message).toBe('origin not allowed');
  });

  it('refuses a missing, forged or unsigned token before any connection', () => {
    const forged = jwt.sign({ typ: 'access', sub: 'u1', role_slugs: ['admin'] }, 'other-secret');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u1"}').toString('base64url')}.`;
    for (const auth of [{}, { token: forged }, { token: none }] as Record<string, string>[]) {
      expect(run(socket({ host: 'app.example' }, auth))?.message).toBe('unauthorized');
    }
  });

  it('lets the mobile app in (no Origin) with a bearer token', () => {
    expect(run(socket({ authorization: `Bearer ${token({})}` }))).toBeUndefined();
  });
});

describe('isAllowedOrigin', () => {
  afterEach(() => delete process.env.ALLOWED_ORIGINS);

  it('allows the same host, the configured origins and no origin', () => {
    expect(isAllowedOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(isAllowedOrigin(undefined, 'x')).toBe(true);
    expect(isAllowedOrigin('https://app.c-mbk.fr', 'api.c-mbk.fr')).toBe(false);
    process.env.ALLOWED_ORIGINS = 'https://app.c-mbk.fr, https://admin.c-mbk.fr';
    expect(isAllowedOrigin('https://app.c-mbk.fr', 'api.c-mbk.fr')).toBe(true);
    expect(isAllowedOrigin('not a url', 'x')).toBe(false);
  });
});
