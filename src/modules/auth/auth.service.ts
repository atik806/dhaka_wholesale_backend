import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import {
  createSupabaseClient,
  createSupabaseAdminClient,
} from '../../config/supabase.config.js';

@Injectable()
export class AuthService {
  private supabase = createSupabaseClient();
  private supabaseAdmin = createSupabaseAdminClient();

  constructor(private configService: ConfigService) {}

  async register(dto: RegisterDto) {
    const { data: authData, error: authError } =
      await this.supabase.auth.signUp({
        email: dto.email,
        password: dto.password,
      });

    if (authError) {
      if (
        authError.message.includes('already registered') ||
        authError.message.includes('already exists')
      ) {
        throw new ConflictException('Email already registered');
      }
      throw new InternalServerErrorException(authError.message);
    }

    const userId = authData.user?.id;
    if (!userId) {
      throw new InternalServerErrorException('Failed to create user');
    }

    const { error: profileError } = await this.supabaseAdmin
      .from('profiles')
      .insert({
        id: userId,
        name: dto.name,
        email: dto.email,
        role: 'customer',
      });

    if (profileError) {
      await this.supabaseAdmin.auth.admin.deleteUser(userId);
      throw new InternalServerErrorException('Failed to create profile');
    }

    return {
      user: {
        id: userId,
        email: dto.email,
        name: dto.name,
        role: 'customer',
      },
      session: authData.session
        ? {
            access_token: authData.session.access_token,
            refresh_token: authData.session.refresh_token,
            expires_at: authData.session.expires_at,
          }
        : null,
      message:
        'Registration successful. Please check your email to confirm your account.',
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
      .select('name, role')
      .eq('id', user.id)
      .single();

    return {
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.email,
        role: profile?.role || 'customer',
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

    if (error || !data.session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = data.user;

    const { data: profile } = await this.supabaseAdmin
      .from('profiles')
      .select('name, role')
      .eq('id', user.id)
      .single();

    return {
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.email,
        role: profile?.role || 'customer',
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
      .select('id, name, email, avatar_url, role')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      throw new UnauthorizedException('User not found');
    }

    return profile;
  }

  async updateProfile(
    userId: string,
    updates: UpdateProfileDto,
  ) {
    const { data, error } = await this.supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException('Failed to update profile');
    }

    return data;
  }

  async adminLogin(dto: LoginDto) {
    const adminEmail = this.configService.get<string>('ADMIN_EMAIL');
    const adminPassword = this.configService.get<string>('ADMIN_PASSWORD');

    if (dto.email !== adminEmail || dto.password !== adminPassword) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    const { data: existingProfile } = await this.supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('email', dto.email)
      .maybeSingle();

    if (existingProfile) {
      if (existingProfile.role !== 'admin') {
        throw new UnauthorizedException('Invalid admin credentials');
      }
      await this.supabaseAdmin.auth.admin.updateUserById(existingProfile.id, {
        password: dto.password,
        email_confirm: true,
      });
    } else {
      const { data: createData, error: createError } =
        await this.supabaseAdmin.auth.admin.createUser({
          email: dto.email,
          password: dto.password,
          email_confirm: true,
        });

      if (createError) {
        throw new InternalServerErrorException(
          'Failed to create admin user: ' + createError.message,
        );
      }

      await this.supabaseAdmin.from('profiles').insert({
        id: createData.user!.id,
        email: dto.email,
        name: 'Admin',
        role: 'admin',
      });
    }

    const { data: signInData, error: signInError } =
      await this.supabase.auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    if (signInError || !signInData?.session) {
      throw new InternalServerErrorException(
        'Failed to sign in: ' + (signInError?.message || ''),
      );
    }

    const userId = signInData.user.id;

    await this.supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          email: dto.email,
          name: 'Admin',
          role: 'admin',
        },
        { onConflict: 'id' },
      );

    return {
      user: {
        id: userId,
        email: dto.email,
        name: 'Admin',
        role: 'admin',
      },
      session: {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
        expires_at: signInData.session.expires_at,
      },
    };
  }
}
