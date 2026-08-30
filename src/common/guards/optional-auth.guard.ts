import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import {
  createSupabaseClient,
  createSupabaseAdminClient,
} from '../../config/supabase.config.js';
import { readAuthCookies } from '../auth/auth-cookies.js';

/**
 * Populates `request.user` when the request carries a valid session, and does
 * nothing when it doesn't — the request is always allowed through. Use on
 * public endpoints that should attribute the action to a signed-in user when
 * one is present (e.g. a bug report filed while logged in) without forcing
 * authentication on anonymous callers.
 *
 * An anonymous request (no Bearer header, no `dw_session` cookie) short-circuits
 * before any Supabase call, so there is no added latency for guests.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  private readonly logger = new Logger(OptionalAuthGuard.name);
  private _supabase: ReturnType<typeof createSupabaseClient>;
  private _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;

  private get supabase() {
    if (!this._supabase) this._supabase = createSupabaseClient();
    return this._supabase;
  }
  private get supabaseAdmin() {
    if (!this._supabaseAdmin) this._supabaseAdmin = createSupabaseAdminClient();
    return this._supabaseAdmin;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) return true;

    try {
      const result = await this.supabase.auth.getUser(token);
      const user = result.data?.user;
      if (result.error || !user) return true;

      let name = user.email ?? '';
      let role = 'customer';
      try {
        const { data } = await this.supabaseAdmin
          .from('profiles')
          .select('name, role')
          .eq('id', user.id)
          .single();
        name = data?.name ?? user.email ?? '';
        role = data?.role ?? 'customer';
      } catch (e) {
        this.logger.warn(`Profile query failed for ${user.id}: ${e}`);
      }

      (
        request as Request & {
          user: { id: string; email: string; name: string; role: string };
        }
      ).user = {
        id: user.id,
        email: user.email ?? '',
        name,
        role,
      };
    } catch (e) {
      // A dead/invalid token on an optional route is not an error — the caller
      // is simply treated as anonymous.
      this.logger.warn(`Optional auth resolve failed: ${e}`);
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer') return token;
    }
    return readAuthCookies(request)?.access_token;
  }
}
