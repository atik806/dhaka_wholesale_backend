import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CheckoutService } from './checkout.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  CheckoutQuoteSchema,
  GuestCheckoutQuoteSchema,
  type CheckoutQuoteDto,
  type GuestCheckoutQuoteDto,
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

  @Post('guest-quote')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'Checkout totals for a guest cart (items required)',
  })
  async guestQuote(
    @Body(new ZodValidationPipe(GuestCheckoutQuoteSchema))
    dto: GuestCheckoutQuoteDto,
  ) {
    return this.checkoutService.quote(undefined, dto);
  }
}
