import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReportsService } from './reports.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OptionalAuthGuard } from '../../common/guards/optional-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import {
  CreateReportSchema,
  type CreateReportDto,
} from './dto/create-report.dto.js';

@ApiTags('Bug Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  // Public endpoint — anonymous reports are allowed. OptionalAuthGuard attaches
  // the user when the request carries a live session so the report is linked to
  // the reporter (the admin UI surfaces this via `user_id`).
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Submit a bug report' })
  async create(
    @Body(new ZodValidationPipe(CreateReportSchema)) dto: CreateReportDto,
    @CurrentUser() user?: JwtUser,
  ) {
    return this.reportsService.create(dto, user?.id);
  }
}
