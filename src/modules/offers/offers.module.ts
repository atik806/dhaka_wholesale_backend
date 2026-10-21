import { Global, Module } from '@nestjs/common';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';
import { PromotionsService } from './promotions.service.js';
import { PromotionsController } from './promotions.controller.js';

@Global()
@Module({
  controllers: [OffersController, PromotionsController],
  providers: [OffersService, PromotionsService],
  exports: [OffersService, PromotionsService],
})
export class OffersModule {}
