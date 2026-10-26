import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import type { Session, User } from '@supabase/supabase-js';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import type { ChangeAdminPasswordDto } from './dto/change-admin-password.dto.js';
import {
  createSupabaseClient,
  createSupabaseAuthClient,
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
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const bootstrapPassword = process.env.ADMIN_PASSWORD;
    const email = dto.email.trim().toLowerCase();

    // Use a temporary anon client for sign-in so we never pollute the shared
    // service-role client's auth state.
    const signInClient = createSupabaseAuthClient();

    let sessionResult: { user: User | null; session: Session | null } | null =
      null;
    const { data: signInData, error: signInError } =
      await signInClient.auth.signInWithPassword({
        email,
        password: dto.password,
      });

    // A failed login may mean either a missing account or a wrong password.
    // Only the deployment bootstrap password may create the privileged user.
    if (signInError) {
      if (
        !adminEmail ||
        email !== adminEmail ||
        !bootstrapPassword ||
        dto.password !== bootstrapPassword
      ) {
        throw new UnauthorizedException('Invalid admin credentials');
      }

      const { data: created, error: createError } =
        await this.supabaseAdmin.auth.admin.createUser({
          email: adminEmail,
          password: dto.password,
          email_confirm: true,
        });
      if (createError || !created.user) {
        throw new UnauthorizedException('Admin login failed');
      }

      const { data: retryData, error: retryError } =
        await signInClient.auth.signInWithPassword({
          email: adminEmail,
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

    let profile: {
      name: string;
      role: string;
      phone: string | null;
      avatar_url: string | null;
      shipping_address: Record<string, string> | null;
    } = {
      name: 'Admin',
      role: 'admin',
      phone: null,
      avatar_url: null,
      shipping_address: null,
    };

    if (email === adminEmail) {
      // Keep the configured bootstrap account compatible with existing setup.
      await this.ensureAdminProfile(sessionResult.user.id, email);
    } else {
      const { data, error } = await this.supabaseAdmin
        .from('profiles')
        .select('name, role, phone, avatar_url, shipping_address')
        .eq('id', sessionResult.user.id)
        .single();

      if (error || !data) {
        // Authentication can succeed for a customer. Revoke that new session
        // before denying admin access; never promote an arbitrary account.
        await this.logout(sessionResult.session.access_token);
        throw new UnauthorizedException('Invalid admin credentials');
      }
      profile = data;
    }

    const { data: access, error: accessError } = await this.supabaseAdmin.rpc(
      'ops_access',
      { p_user: sessionResult.user.id },
    );
    if (accessError || !access?.enabled || !access.groups?.length) {
      await this.logout(sessionResult.session.access_token);
      throw new UnauthorizedException(
        'Admin access is disabled or unavailable',
      );
    }

    return {
      user: {
        id: sessionResult.user.id,
        email,
        name: profile.name,
        role: profile.role,
        phone: profile.phone,
        avatar_url: profile.avatar_url,
        shipping_address: profile.shipping_address,
      },
      session: {
        access_token: sessionResult.session.access_token,
        refresh_token: sessionResult.session.refresh_token,
        expires_at: sessionResult.session.expires_at,
      },
    };
  }

  async changeAdminPassword(
    userId: string,
    email: string,
    dto: ChangeAdminPasswordDto,
  ) {
    // A stolen but still-live admin cookie is not enough to rotate the
    // password: the current password must also be verified with Supabase.
    const verificationClient = createSupabaseAuthClient();
    const { data: verified, error: verifyError } =
      await verificationClient.auth.signInWithPassword({
        email,
        password: dto.current_password,
      });

    if (verifyError || !verified.user || verified.user.id !== userId) {
      throw new BadRequestException('Current password is incorrect');
    }

    const { error: updateError } =
      await this.supabaseAdmin.auth.admin.updateUserById(userId, {
        password: dto.new_password,
      });
    if (updateError) {
      this.logger.error(
        `Failed to change admin password for ${userId}: ${updateError.message}`,
      );
      throw new InternalServerErrorException('Could not update password');
    }

    // Invalidate refresh tokens after rotation. The controller also clears the
    // browser cookie, forcing a new login with the replacement password.
    if (verified.session?.access_token) {
      try {
        await this.supabaseAdmin.auth.admin.signOut(
          verified.session.access_token,
        );
      } catch (error) {
        this.logger.warn(
          `Session revoke failed after admin password change: ${error}`,
        );
      }
    }

    return {
      message: 'Password updated. Sign in again with your new password.',
    };
  }

  private async ensureAdminProfile(userId: string, email: string) {
    const { error } = await this.supabaseAdmin.from('profiles').upsert(
      {
        id: userId,
        email,
        role: 'admin',
        name: 'Admin',
      },
      { onConflict: 'id' },
    );
    if (error) {
      this.logger.error(
        `Failed to sync admin profile for ${userId}: ${error.message} (${error.code})`,
      );
      throw new InternalServerErrorException('Admin profile setup failed');
    }
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
   * httpOnly cookie. Both tokens are verified server-side before any cookie is
   * set:
   *   1. the access token is checked against the auth API (getUser);
   *   2. the refresh token is exchanged via refreshSession(), which proves it
   *      is a real, live session and rotates it; the pair is rejected unless
   *      the refreshed session belongs to the SAME account as the access token
   *      (H3 — an attacker can no longer plant a mismatched/foreign refresh
   *      token in the victim's cookie jar).
   * The cookie is populated from the server-issued session, never from the
   * client-supplied token values.
   */
  async syncSession(accessToken: string, refreshToken: string) {
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Exchange + rotate the refresh token. A revoked, forged or otherwise
    // invalid token makes refreshSession() fail here, so no cookie is set.
    const { data: refreshed, error: refreshError } =
      await this.supabase.auth.refreshSession({
        refresh_token: refreshToken,
      });
    if (refreshError || !refreshed.session || !refreshed.session.user) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (refreshed.session.user.id !== data.user.id) {
      throw new UnauthorizedException('Refresh token does not match session');
    }

    const userId = data.user.id;

    // Existing profiles keep their stored name/role — never overwrite them on
    // a repeat OAuth sign-in (mirrors the old getProfile-first flow). Only a
    // brand-new OAuth user with no profile row yet gets one created via
    // syncOAuthProfile, which is role-safe.
    const { data: existing } = await this.supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    const user = existing
      ? await this.getProfile(userId)
      : await this.syncOAuthProfile(
          userId,
          data.user.user_metadata?.full_name ??
            data.user.user_metadata?.name ??
            data.user.email ??
            '',
          data.user.email ?? '',
        );

    return {
      user,
      session: {
        access_token: refreshed.session.access_token,
        refresh_token: refreshed.session.refresh_token,
        expires_at: refreshed.session.expires_at,
      },
    };
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
