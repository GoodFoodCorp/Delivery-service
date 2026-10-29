import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

/** Authenticated caller extracted from the auth-service access token (HS256 shared secret). */
export interface Actor {
  userId: string;
  tenantId: string;
  roles: string[];
  token: string;
}

export const ROLES_KEY = 'roles';

/**
 * Verifies an access token: HS256 signature, expiry, issuer, audience and
 * typ=access. Refresh tokens (another key, typ=refresh), unsigned tokens and
 * tokens minted for another audience are refused.
 */
export function verifyToken(token: string): Actor {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  const payload = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: process.env.JWT_ISSUER ?? 'goodfood-auth',
    audience: process.env.JWT_AUDIENCE ?? 'goodfood-api',
    clockTolerance: 30,
  }) as jwt.JwtPayload;
  if (payload.typ !== 'access') {
    throw new Error('not an access token');
  }
  if (!payload.sub || typeof payload.exp !== 'number') {
    throw new Error('token has no subject or expiry');
  }
  const roles = Array.isArray(payload.role_slugs)
    ? payload.role_slugs.map((r: string) => r.toLowerCase())
    : [];
  return {
    userId: String(payload.sub),
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : '',
    roles,
    token,
  };
}

/** Reads the JWT from the Authorization header or the auth_token cookie. */
export function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  const cookies = req.headers.cookie?.split(';').map((c) => c.trim());
  const authCookie = cookies?.find((c) => c.startsWith('auth_token='));
  return authCookie?.slice('auth_token='.length);
}
