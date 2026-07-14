import { Controller, Post, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RegisterSchema, type RegisterDto } from './dto/register.dto.js';
import { LoginSchema, type LoginDto } from './dto/login.dto.js';
import { RefreshTokenSchema, type RefreshTokenDto } from './dto/refresh-token.dto.js';
import {
  UpdateProfileSchema,
  type UpdateProfileDto,
} from './dto/update-profile.dto.js';

const SyncProfileSchema = z.object({
  name: z.string().transform((v) => v || 'User'),
  email: z.string().email(),
});

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto,
  ) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('admin-login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Admin login with credentials from .env' })
  async adminLogin(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Post('refresh')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  async refreshToken(
    @Body(new ZodValidationPipe(RefreshTokenSchema)) dto: RefreshTokenDto,
  ) {
    return this.authService.refreshToken(dto.refresh_token);
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
    @Body(new ZodValidationPipe(SyncProfileSchema)) dto: { name: string; email: string },
  ) {
    return this.authService.syncOAuthProfile(user.id, dto.name, dto.email);
  }
}
