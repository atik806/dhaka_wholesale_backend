import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
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
import { PromotionsService } from './promotions.service.js';

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
  async manage() {
    const [combos, coupons] = await Promise.all([
      this.promotions.combos(),
      this.promotions.coupons(),
    ]);
    return { combos, coupons };
  }
  @Put('combos')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  saveCombo(
    @Body(new ZodValidationPipe(ComboSchema)) value: ComboDeal,
    @Request() request: { user: { id: string } },
  ) {
    return this.promotions.saveCombo(value, request.user.id);
  }
  @Put('coupons')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  saveCoupon(
    @Body(new ZodValidationPipe(CouponSchema)) value: Coupon,
    @Request() request: { user: { id: string } },
  ) {
    return this.promotions.saveCoupon(value, request.user.id);
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
