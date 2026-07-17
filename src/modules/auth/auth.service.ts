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

    // When ADMIN_EMAIL and ADMIN_PASSWORD are set, validate against them directly
    if (adminEmail && adminPassword) {
      if (dto.email !== adminEmail || dto.password !== adminPassword) {
        throw new UnauthorizedException('Invalid admin credentials');
      }

      // Try sign-in first
      const { data: signInData, error: signInError } =
        await this.supabaseAdmin.auth.signInWithPassword({
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
          await this.supabaseAdmin.auth.signInWithPassword({
            email: dto.email,
            password: dto.password,
          });
        if (retryError) {
          throw new UnauthorizedException('Admin login failed');
        }
        signInData = retryData;
      }

      if (!signInData?.session || !signInData.user) {
        throw new UnauthorizedException('Admin login failed');
      }

      return {
        user: {
          id: signInData.user.id,
          email: dto.email,
          name: 'Admin',
          role: 'admin' as const,
          phone: null,
          avatar_url: null,
          shipping_address: null,
        },
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
          expires_at: signInData.session.expires_at,
        },
      };
    }

    // Fallback: no env vars set — any user with role=admin in profiles can log in
    const { data: signInData, error: signInError } =
      await this.supabaseAdmin.auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    if (signInError || !signInData?.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const userId = signInData.user.id;

    const { data: profile } = await this.supabaseAdmin
      .from('profiles')
      .select('id, name, email, role, phone, avatar_url, shipping_address')
      .eq('id', userId)
      .maybeSingle();

    if (profile?.role === 'admin') {
      return {
        user: {
          id: userId,
          email: dto.email,
          name: profile.name || 'Admin',
          role: 'admin' as const,
          phone: profile.phone || null,
          avatar_url: profile.avatar_url || null,
          shipping_address: profile.shipping_address || null,
        },
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
          expires_at: signInData.session.expires_at,
        },
      };
    }

    throw new UnauthorizedException('You do not have admin access');
  }

  async syncOAuthProfile(userId: string, name: string, email: string) {
    const displayName = name || email.split('@')[0] || 'User';

    // Direct upsert — no prior delete (avoids race conditions and RLS issues)
    const { error: upsertError } = await this.supabaseAdmin
      .from('profiles')
      .upsert(
        { id: userId, name: displayName, email, role: 'customer' },
        { onConflict: 'id' },
      );

    if (upsertError) {
      this.logger.error(
        `Failed to sync OAuth profile (attempt 1): ${upsertError.message} (${upsertError.code})`,
      );

      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 500));

      const { error: retryError } = await this.supabaseAdmin
        .from('profiles')
        .upsert(
          { id: userId, name: displayName, email, role: 'customer' },
          { onConflict: 'id' },
        );

      if (retryError) {
        this.logger.error(
          `Failed to sync OAuth profile (attempt 2): ${retryError.message} (${retryError.code})`,
        );
        throw new InternalServerErrorException('Failed to create user profile');
      }
    }

    // Verify profile exists
    try {
      return await this.getProfile(userId);
    } catch {
      this.logger.error(
        `Profile upsert succeeded but getProfile failed for user ${userId}`,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve created profile',
      );
    }
  }
}
