import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../auth.util';

/** Restricts a route to the given role slugs (checked by RolesGuard). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
