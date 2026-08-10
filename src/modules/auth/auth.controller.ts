import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RegisterSchema, type RegisterDto } from './dto/register.dto.js';
import { LoginSchema, type LoginDto } from './dto/login.dto.js';
import {
  RefreshTokenSchema,
  type RefreshTokenDto,
} from './dto/refresh-token.dto.js';
import {
  UpdateProfileSchema,
  type UpdateProfileDto,
} from './dto/update-profile.dto.js';
import {
  setAuthCookies,
  clearAuthCookies,
  readAuthCookies,
} from '../../common/auth/auth-cookies.js';

const SyncProfileSchema = z.object({
  name: z.string().transform((v) => v || 'User'),
  email: z.string().email(),
});

/**
 * Body for importing a Supabase-client session (OAuth callback) into the
 * httpOnly cookie. The tokens travel once, inside a JSON request body that
 * only our own origin can read — they are never exposed to JS storage.
 */
const SyncSessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().optional(),
});
type SyncSessionDto = z.infer<typeof SyncSessionSchema>;

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto,
  ) {
    const result = await this.authService.register(dto);
    if (result.session) setAuthCookies(res, result.session);
    // Tokens only ever reach the browser via the httpOnly cookie — the
    // response body carries the user object alone. `authed` tells the
    // frontend whether the session cookie was actually set (the user row is
    // always created, but the auto sign-in after registration can fail).
    return {
      user: result.user,
      message: result.message,
      authed: !!result.session,
    };
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
  ) {
    const result = await this.authService.login(dto);
    setAuthCookies(res, result.session);
    return { user: result.user };
  }

  @Post('admin-login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Admin login with credentials from .env' })
  async adminLogin(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
  ) {
    const result = await this.authService.adminLogin(dto);
    setAuthCookies(res, result.session);
    return { user: result.user };
  }

  @Post('refresh')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(RefreshTokenSchema)) dto: RefreshTokenDto,
  ) {
    // The cookie is the primary source; the body is accepted for backwards
    // compatibility so API clients can still pass a token explicitly.
    const refreshToken =
      dto.refresh_token ?? readAuthCookies(req)?.refresh_token;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }
    const result = await this.authService.refreshToken(refreshToken);
    setAuthCookies(res, result.session);
    return { user: result.user };
  }

  @Post('logout')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Logout and clear the session cookie' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const accessToken = readAuthCookies(req)?.access_token;
    const result = await this.authService.logout(accessToken);
    clearAuthCookies(res);
    return result;
  }

  @Post('sync-session')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Import a Supabase client session into httpOnly cookies',
  })
  async syncSession(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(SyncSessionSchema)) dto: SyncSessionDto,
  ) {
    const result = await this.authService.syncSession(dto.access_token);
    setAuthCookies(res, {
      access_token: dto.access_token,
      refresh_token: dto.refresh_token,
      expires_at: dto.expires_at,
    });
    return { user: result };
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: JwtUser) {
    return this.authService.getProfile(user.id);
  }

  @Patch('profile')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(
    @CurrentUser() user: JwtUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) updates: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.id, updates);
  }

  @Post('sync-profile')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync OAuth user profile (creates if missing)' })
  async syncProfile(
    @CurrentUser() user: JwtUser,
    @Body(new ZodValidationPipe(SyncProfileSchema))
    dto: { name: string; email: string },
  ) {
    return this.authService.syncOAuthProfile(user.id, dto.name, dto.email);
  }
}
