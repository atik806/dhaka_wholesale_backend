import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { CheckoutModule } from './modules/checkout/checkout.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { WishlistModule } from './modules/wishlist/wishlist.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { UploadModule } from './modules/upload/upload.module.js';
import { ContactModule } from './modules/contact/contact.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { SiteSettingsModule } from './modules/site-settings/site-settings.module.js';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 60,
      },
    ]),
    AuthModule,
    CategoriesModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    CheckoutModule,
    ReviewsModule,
    WishlistModule,
    AdminModule,
    UploadModule,
    ContactModule,
    ReportsModule,
    SiteSettingsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpCacheInterceptor,
    },
  ],
})
export class AppModule {}
