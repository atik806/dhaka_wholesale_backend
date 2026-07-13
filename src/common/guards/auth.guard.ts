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

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private _supabase = createSupabaseClient();
  private _supabaseAdmin = createSupabaseAdminClient();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token is required');
    }

    let user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;

    try {
      const result = await this._supabase.auth.getUser(token);
      if (result.error || !result.data?.user) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      user = result.data.user;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.error(`Auth getUser failed: ${e}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    let profile: { name: string; role: string } | null = null;

    try {
      const { data } = await this._supabaseAdmin
        .from('profiles')
        .select('name, role')
        .eq('id', user!.id)
        .single();
      profile = data;
    } catch (e) {
      this.logger.warn(`Profile query failed for ${user!.id}: ${e}`);
    }

    if (!profile) {
      const name =
        (user!.user_metadata?.full_name ??
        user!.user_metadata?.name ??
        user!.email ??
        '').toString().slice(0, 100).replace(/[<>]/g, '');
      const avatar_url = typeof user!.user_metadata?.avatar_url === 'string'
        ? (user!.user_metadata!.avatar_url as string).slice(0, 500)
        : null;

      try {
        await this._supabaseAdmin
          .from('profiles')
          .upsert(
            { id: user!.id, name, email: user!.email ?? '', avatar_url, role: 'customer' },
            { onConflict: 'id' },
          );
      } catch (e) {
        this.logger.error(`Failed to create OAuth profile: ${e}`);
      }

      profile = { name, role: 'customer' };
    }

    (
      request as Request & {
        user: { id: string; email: string; name: string; role: string };
      }
    ).user = {
      id: user.id,
      email: user.email ?? '',
      name: profile?.name ?? user.email ?? '',
      role: profile?.role ?? 'customer',
    };

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) return undefined;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
