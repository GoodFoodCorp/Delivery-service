import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Actor } from '../auth.util';

/** Injects the authenticated Actor (set by JwtAuthGuard) into a handler. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest().actor;
});
