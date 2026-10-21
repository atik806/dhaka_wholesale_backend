import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { FlashSaleSchema, type FlashSale } from './offer-pricing.js';
import { OffersService } from './offers.service.js';

@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get() {
    return this.offers.get();
  }

  @Put()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  save(
    @Body(new ZodValidationPipe(FlashSaleSchema)) sale: FlashSale,
    @Request() request: { user: { id: string } },
  ) {
    return this.offers.save(sale, request.user.id);
  }

  @Post('end')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  end(@Request() request: { user: { id: string } }) {
    return this.offers.end(request.user.id);
  }
}
