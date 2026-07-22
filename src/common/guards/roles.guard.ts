import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Actor, ROLES_KEY } from '../auth.util';

/** Enforces @Roles() metadata against the authenticated Actor. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const { actor } = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
    if (!actor || !required.some((r) => actor.roles.includes(r))) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
