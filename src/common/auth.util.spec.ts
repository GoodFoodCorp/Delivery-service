import * as jwt from 'jsonwebtoken';
import { verifyToken } from './auth.util';

const SECRET = 'test-secret-long-enough-for-hs256-signing';

function sign(claims: Record<string, unknown>, secret = SECRET) {
  return jwt.sign(
    { sub: 'u1', typ: 'access', iss: 'goodfood-auth', aud: 'goodfood-api', role_slugs: ['LIVREUR'], ...claims },
    secret,
    { algorithm: 'HS256', expiresIn: 60 },
  );
}

describe('verifyToken', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it('accepts an access token and lowercases roles', () => {
    expect(verifyToken(sign({}))).toMatchObject({ userId: 'u1', roles: ['livreur'] });
  });

  it.each([
    ['a refresh token', { typ: 'refresh' }],
    ['an untyped token', { typ: undefined }],
    ['another audience', { aud: 'elsewhere' }],
    ['another issuer', { iss: 'elsewhere' }],
  ])('rejects %s', (_name, claims) => {
    expect(() => verifyToken(sign(claims))).toThrow();
  });

  it('rejects a token signed with another key or unsigned', () => {
    expect(() => verifyToken(sign({}, 'another-secret-long-enough-for-hs256'))).toThrow();
    const unsigned = jwt.sign({ sub: 'u1', typ: 'access' }, '', { algorithm: 'none' });
    expect(() => verifyToken(unsigned)).toThrow();
  });
});
