import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CheckoutService } from './checkout.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  CheckoutQuoteSchema,
  type CheckoutQuoteDto,
} from './dto/checkout-quote.dto.js';

@ApiTags('Checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post('quote')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get authoritative checkout totals (subtotal, shipping, tax, total)',
  })
  async quote(
    @CurrentUser() user: JwtUser,
    @Body(new ZodValidationPipe(CheckoutQuoteSchema)) dto: CheckoutQuoteDto,
  ) {
    return this.checkoutService.quote(user.id, dto);
  }
}
