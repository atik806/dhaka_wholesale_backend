import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import {
  createSupabaseClient,
  createSupabaseAdminClient,
} from '../../config/supabase.config.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private _supabase: ReturnType<typeof createSupabaseClient> | null = null;
  private _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient> | null =
    null;

  private get supabase() {
    if (!this._supabase) this._supabase = createSupabaseClient();
    return this._supabase;
  }
  private get supabaseAdmin() {
    if (!this._supabaseAdmin) this._supabaseAdmin = createSupabaseAdminClient();
    return this._supabaseAdmin;
  }

  async register(dto: RegisterDto) {
    const { data: authData, error: authError } =
      await this.supabaseAdmin.auth.admin.createUser({
        email: dto.email,
        password: dto.password,
        email_confirm: true,
      });

    if (authError) {
      if (
        authError.message.includes('already registered') ||
        authError.message.includes('already exists')
      ) {
        throw new ConflictException('Email already registered');
      }
      throw new InternalServerErrorException('Registration failed');
    }

    const userId = authData.user?.id;
    if (!userId) {
      throw new InternalServerErrorException('Failed to create user');
    }

    const { error: profileError } = await this.supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          name: dto.name,
          email: dto.email,
          role: 'customer',
        },
        { onConflict: 'id' },
      );

    if (profileError) {
      this.logger.error(
        `Failed to create profile: ${profileError.message} (${profileError.code})`,
      );
      await this.supabaseAdmin.auth.admin.deleteUser(userId);
      throw new InternalServerErrorException('Failed to create profile');
    }

    const anonClient = createSupabaseClient();
    const { data: sessionData, error: signInError } =
      await anonClient.auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    if (signInError) {
      this.logger.error(
        `Failed to sign in after registration: ${signInError.message}`,
      );
      return {
        user: {
          id: userId,
          email: dto.email,
          name: dto.name,
          role: 'customer',
        },
        session: null,
        message: 'Registration successful. Please sign in.',
      };
    }

    return {
      user: {
        id: userId,
        email: dto.email,
        name: dto.name,
        role: 'customer',
      },
      session: sessionData.session
        ? {
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
            expires_at: sessionData.session.expires_at,
          }
        : null,
      message: 'Registration successful',
    };
  }

  async login(dto: LoginDto) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: dto.email,
      password: dto.password,
    });

    if (error) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = data.user;

    const { data: profile } = await this.supabaseAdmin
      .from('profiles')
      .select('name, role, phone, avatar_url, shipping_address')
      .eq('id', user.id)
      .single();

    return {
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.email,
        role: profile?.role || 'customer',
        phone: profile?.phone || null,
        avatar_url: profile?.avatar_url || null,
        shipping_address: profile?.shipping_address || null,
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    };
  }

  async refreshToken(refreshToken: string) {
    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session || !data.user) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = data.user;

    const { data: profile } = await this.supabaseAdmin
      .from('profiles')
      .select('name, role, phone, avatar_url, shipping_address')
      .eq('id', user.id)
      .single();

    return {
      user: {
        id: user.id,
        email: user.email ?? '',
        name: profile?.name ?? user.email ?? '',
        role: profile?.role || 'customer',
        phone: profile?.phone || null,
        avatar_url: profile?.avatar_url || null,
        shipping_address: profile?.shipping_address || null,
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    };
  }

  async getProfile(userId: string) {
    const { data: profile, error } = await this.supabaseAdmin
      .from('profiles')
      .select('id, name, email, phone, avatar_url, shipping_address, role')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      throw new NotFoundException('User not found');
    }

    return profile;
  }

  async updateProfile(userId: string, updates: UpdateProfileDto) {
    const { data, error } = await this.supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('id, name, phone, avatar_url, shipping_address, role, updated_at')
      .single();

    if (error) {
      this.logger.error(
        `Failed to update profile: ${error.message} (${error.code})`,
      );
      throw new InternalServerErrorException('Failed to update profile');
    }

    return data;
  }

  async adminLogin(dto: LoginDto) {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    // Use a temporary anon client for sign-in so we never pollute
    // the shared admin client's auth state. The shared admin client
    // must stay unauthenticated so it bypasses RLS via service_role key.
    const signInClient = createSupabaseClient();

    // Admin access is fail-closed: it requires ADMIN_EMAIL and
    // ADMIN_PASSWORD to be configured. Without them we refuse rather
    // than falling back to "any profile with role=admin" — that path
    // made the admin role itself the whole security boundary, which
    // the RLS hardening (role column no longer client-writable) is
    // specifically designed to protect.
    if (!adminEmail || !adminPassword) {
      this.logger.error(
        'ADMIN_EMAIL / ADMIN_PASSWORD are not set — admin login disabled',
      );
      throw new UnauthorizedException('Admin login is not configured');
    }

    if (dto.email !== adminEmail || dto.password !== adminPassword) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    // Try sign-in first
    let sessionResult: { user: any; session: any } | null = null;
    const { data: signInData, error: signInError } =
      await signInClient.auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    // If the admin account doesn't exist in Supabase yet, create it
    if (signInError) {
      const { data: created, error: createError } =
        await this.supabaseAdmin.auth.admin.createUser({
          email: dto.email,
          password: dto.password,
          email_confirm: true,
        });
      if (createError) {
        throw new UnauthorizedException('Admin login failed');
      }

      await this.supabaseAdmin.from('profiles').upsert(
        {
          id: created.user.id,
          email: dto.email,
          role: 'admin',
          name: 'Admin',
        },
        { onConflict: 'id' },
      );

      // Sign in after creating the account
      const { data: retryData, error: retryError } =
        await signInClient.auth.signInWithPassword({
          email: dto.email,
          password: dto.password,
        });
      if (retryError) {
        throw new UnauthorizedException('Admin login failed');
      }
      sessionResult = retryData;
    } else {
      sessionResult = signInData;
    }

    if (!sessionResult?.session || !sessionResult.user) {
      throw new UnauthorizedException('Admin login failed');
    }

    return {
      user: {
        id: sessionResult.user.id,
        email: dto.email,
        name: 'Admin',
        role: 'admin' as const,
        phone: null,
        avatar_url: null,
        shipping_address: null,
      },
      session: {
        access_token: sessionResult.session.access_token,
        refresh_token: sessionResult.session.refresh_token,
        expires_at: sessionResult.session.expires_at,
      },
    };
  }

  /**
   * Best-effort server-side session revocation. Failure here is never fatal:
   * the controller clears the cookie regardless, so a user can always log out
   * even if the auth API is unreachable.
   */
  async logout(accessToken?: string) {
    if (accessToken) {
      try {
        await this.supabaseAdmin.auth.admin.signOut(accessToken);
      } catch (e) {
        this.logger.warn(`Session revoke failed during logout: ${e}`);
      }
    }
    return { message: 'Logged out' };
  }

  /**
   * Import a Supabase-client session (from the OAuth callback) into the
   * httpOnly cookie. The access token is verified against the auth API before
   * any cookie is set; the refresh token is stored for later /auth/refresh.
   */
  async syncSession(accessToken: string) {
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Existing profiles keep their stored name/role — never overwrite them on
    // a repeat OAuth sign-in (mirrors the old getProfile-first flow). Only a
    // brand-new OAuth user with no profile row yet gets one created via
    // syncOAuthProfile, which is role-safe (M3).
    const { data: existing } = await this.supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', data.user.id)
      .maybeSingle();

    if (existing) {
      return this.getProfile(data.user.id);
    }

    const oauthName =
      data.user.user_metadata?.full_name ??
      data.user.user_metadata?.name ??
      data.user.email ??
      '';
    const oauthEmail = data.user.email ?? '';

    return this.syncOAuthProfile(data.user.id, oauthName, oauthEmail);
  }

  async syncOAuthProfile(userId: string, name: string, email: string) {
    const displayName = name || email.split('@')[0] || 'User';

    // Never overwrite an existing profile's role. A blind upsert that resets
    // role:'customer' would silently demote an admin who signs in via Google
    // on every sync. Fetch first, update only name/email on existing rows,
    // and only seed role:'customer' when creating a brand-new profile.
    const { data: existing } = await this.supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (existing) {
      const { error: updateError } = await this.supabaseAdmin
        .from('profiles')
        .update({ name: displayName, email })
        .eq('id', userId);

      if (updateError) {
        this.logger.error(
          `Failed to sync OAuth profile (update) for user ${userId}: ${updateError.message} (${updateError.code}). Check that SUPABASE_SERVICE_ROLE_KEY is set in Vercel env vars.`,
        );
        throw new InternalServerErrorException('Failed to update user profile');
      }
    } else {
      const { error: insertError } = await this.supabaseAdmin
        .from('profiles')
        .insert({ id: userId, name: displayName, email, role: 'customer' });

      if (insertError) {
        this.logger.error(
          `Failed to sync OAuth profile (insert) for user ${userId}: ${insertError.message} (${insertError.code}). Check that SUPABASE_SERVICE_ROLE_KEY is set in Vercel env vars.`,
        );
        throw new InternalServerErrorException('Failed to create user profile');
      }
    }

    // Verify profile exists
    try {
      return await this.getProfile(userId);
    } catch {
      this.logger.error(
        `Profile sync succeeded but getProfile failed for user ${userId}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve created profile',
      );
    }
  }
}
