import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  PERMISSION_KEY,
  permissionsFor,
  allows,
  legacyPermission,
} from '../../modules/operations/permissions.js';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: { id: string; role: string; permissions?: string[] };
      originalUrl: string;
      url: string;
      method: string;
    }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (requiredRoles.includes('admin')) {
      const { data, error } = await createSupabaseAdminClient().rpc(
        'ops_access',
        { p_user: user.id },
      );
      if (error || !data?.enabled)
        throw new ForbiddenException('Admin access is disabled or unavailable');
      const permissions = permissionsFor(data.groups ?? []);
      user.permissions = permissions;
      const permission =
        this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ??
        legacyPermission(request.originalUrl ?? request.url, request.method);
      if (!allows(permissions, permission))
        throw new ForbiddenException('Insufficient permissions');
      return true;
    }
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
