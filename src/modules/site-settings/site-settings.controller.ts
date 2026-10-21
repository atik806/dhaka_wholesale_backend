import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Put,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SiteSettingsService } from './site-settings.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('Site Settings')
@Controller('site-settings')
export class SiteSettingsController {
  constructor(private readonly siteSettingsService: SiteSettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get all site settings (public)' })
  async getAll() {
    return this.siteSettingsService.getAll();
  }

  @Get(':key')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a specific site setting (public)' })
  async get(@Param('key') key: string) {
    return this.siteSettingsService.get(key);
  }

  @Put()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update site settings (admin only)' })
  async update(@Body() body: Record<string, unknown>, @Request() req: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Request body must be a JSON object');
    }
    const userId = req.user?.id;
    return this.siteSettingsService.updateMany(body, userId);
  }

  @Put(':key')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a specific site setting (admin only)' })
  async updateOne(
    @Param('key') key: string,
    @Body() body: { value: Record<string, unknown> },
    @Request() req: any,
  ) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Request body must be a JSON object');
    }
    const userId = req.user?.id;
    return this.siteSettingsService.update(key, body.value, userId);
  }
}
