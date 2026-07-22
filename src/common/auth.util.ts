import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

/** Authenticated caller extracted from the auth-service JWT (HS256 shared secret). */
export interface Actor {
  userId: string;
  tenantId: string;
  roles: string[];
  /** Raw bearer token, forwarded on service-to-service calls (order-service). */
  token: string;
}

export const ROLES_KEY = 'roles';

export function verifyToken(token: string): Actor {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  const roles = Array.isArray(payload.role_slugs)
    ? payload.role_slugs.map((r: string) => r.toLowerCase())
    : [];
  if (!payload.sub) {
    throw new Error('token has no subject');
  }
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
