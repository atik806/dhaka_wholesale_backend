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

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
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
      name = user.email ?? '';
      role = 'customer';
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
