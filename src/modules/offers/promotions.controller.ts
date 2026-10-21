import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';
import {
  ComboSchema,
  CouponSchema,
  type ComboDeal,
  type Coupon,
} from './promotions-pricing.js';
import {
  PromotionsService,
  type ExpectedVersion,
} from './promotions.service.js';

const ExpectedVersionSchema = z
  .union([z.literal('new'), z.iso.datetime({ offset: true })])
  .optional();

/**
 * X-Expected-Version: 'new' when creating, or the updated_at the admin's
 * edit started from. A stale version is rejected with 409 instead of
 * overwriting another admin's change. Absent for older clients.
 */
function expectedVersion(header: string | undefined): ExpectedVersion {
  const result = ExpectedVersionSchema.safeParse(header || undefined);
  if (!result.success)
    throw new BadRequestException('Invalid X-Expected-Version header');
  return result.data;
}

@Controller('offers')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}
  @Get('combos')
  @Header('Cache-Control', 'no-store')
  combos() {
    return this.promotions.activeCombos();
  }
  @Get('manage')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  manage() {
    return this.promotions.managed();
  }
  @Put('combos')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  saveCombo(
    @Body(new ZodValidationPipe(ComboSchema)) value: ComboDeal,
    @Request() request: { user: { id: string } },
    @Headers('x-expected-version') version?: string,
  ) {
    return this.promotions.saveCombo(
      value,
      request.user.id,
      expectedVersion(version),
    );
  }
  @Put('coupons')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  saveCoupon(
    @Body(new ZodValidationPipe(CouponSchema)) value: Coupon,
    @Request() request: { user: { id: string } },
    @Headers('x-expected-version') version?: string,
  ) {
    return this.promotions.saveCoupon(
      value,
      request.user.id,
      expectedVersion(version),
    );
  }
  @Delete('combos/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  removeCombo(@Param('id', UuidParamPipe) id: string) {
    return this.promotions.removeCombo(id);
  }
  @Delete('coupons/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  removeCoupon(@Param('id', UuidParamPipe) id: string) {
    return this.promotions.removeCoupon(id);
  }
}
