import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { Actor, extractToken, verifyToken } from '../auth.util';

/** Validates the JWT and stores the resulting Actor on the request. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const token = extractToken(req);
    if (!token) {
      throw new UnauthorizedException('missing authentication token');
    }
    try {
      req.actor = verifyToken(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
    return true;
  }
}
