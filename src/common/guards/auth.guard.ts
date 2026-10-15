import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import {
  createSupabaseClient,
  createSupabaseAdminClient,
} from '../../config/supabase.config.js';
import { readAuthCookies } from '../auth/auth-cookies.js';
import { CacheStore } from '../cache/cache-store.js';

/** How long a `profiles` (name/role) lookup may be served from cache. Bounds
 * how stale a just-changed role can appear; role writes also proactively
 * bust this key, so this TTL is only the fallback ceiling. */
const PROFILE_CACHE_TTL_SECONDS = 30;

export function profileCacheKey(userId: string): string {
  return `profile:${userId}`;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private _supabase: ReturnType<typeof createSupabaseClient>;
  private _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;

  constructor(private readonly cacheStore: CacheStore) {}

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

    if (!token) {
      throw new UnauthorizedException('Authentication token is required');
    }

    let user: { id: string; email?: string } | null = null;

    try {
      const result = await this.supabase.auth.getUser(token);
      if (result.error || !result.data?.user) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      user = result.data.user;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.error(`Auth getUser failed: ${e}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    let name: string;
    let role: string;
    const cacheKey = profileCacheKey(user.id);
    const cached = this.cacheStore.get(cacheKey) as
      { name: string; role: string } | undefined;
    if (cached) {
      name = cached.name;
      role = cached.role;
    } else {
      try {
        const { data } = await this.supabaseAdmin
          .from('profiles')
          .select('name, role')
          .eq('id', user.id)
          .single();
        name = data?.name ?? user.email ?? '';
        role = data?.role ?? 'customer';
        this.cacheStore.set(
          cacheKey,
          { name, role },
          PROFILE_CACHE_TTL_SECONDS,
        );
      } catch (e) {
        this.logger.warn(`Profile query failed for ${user.id}: ${e}`);
        name = user.email ?? '';
        role = 'customer';
      }
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

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (authHeader) {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer') return token;
    }

    // No Authorization header — fall back to the httpOnly `dw_session`
    // cookie set by the auth endpoints. The client sends tokens only via
    // this cookie (never in JS-accessible storage).
    return readAuthCookies(request)?.access_token;
  }
}
