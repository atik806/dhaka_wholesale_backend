import { Module, forwardRef } from '@nestjs/common';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { CategoriesModule } from '../categories/categories.module.js';

@Module({
  imports: [forwardRef(() => CategoriesModule)],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
