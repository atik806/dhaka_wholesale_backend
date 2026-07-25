import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CartService } from './cart.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';
import {
  AddCartItemSchema,
  UpdateCartItemSchema,
  MergeCartSchema,
  type AddCartItemDto,
  type UpdateCartItemDto,
  type MergeCartDto,
} from './dto/cart-item.dto.js';
import type { DeliveryZone } from '../../common/utils/commerce.js';

@ApiTags('Cart')
@Controller('cart')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Get user cart items' })
  async getCart(@CurrentUser() user: JwtUser) {
    return this.cartService.findByUser(user.id);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get cart summary with zone-based shipping totals' })
  @ApiQuery({
    name: 'delivery_zone',
    required: false,
    enum: ['inside_dhaka', 'outside_dhaka'],
  })
  async getSummary(
    @CurrentUser() user: JwtUser,
    @Query('delivery_zone') deliveryZone?: string,
  ) {
    const zone: DeliveryZone =
      deliveryZone === 'outside_dhaka' ? 'outside_dhaka' : 'inside_dhaka';
    return this.cartService.getCartSummary(user.id, zone);
  }

  @Post('merge')
  @ApiOperation({
    summary: 'Merge guest cart items into the authenticated user cart',
  })
  async mergeCart(
    @CurrentUser() user: JwtUser,
    @Body(new ZodValidationPipe(MergeCartSchema)) dto: MergeCartDto,
  ) {
    return this.cartService.mergeItems(user.id, dto);
  }

  @Post()
  @ApiOperation({ summary: 'Add item to cart' })
  async addItem(
    @CurrentUser() user: JwtUser,
    @Body(new ZodValidationPipe(AddCartItemSchema)) dto: AddCartItemDto,
  ) {
    return this.cartService.addItem(user.id, dto);
  }

  @Patch(':itemId')
  @ApiOperation({ summary: 'Update cart item quantity or variant' })
  async updateItem(
    @CurrentUser() user: JwtUser,
    @Param('itemId', UuidParamPipe) itemId: string,
    @Body(new ZodValidationPipe(UpdateCartItemSchema)) dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(itemId, user.id, dto);
  }

  @Delete(':itemId')
  @ApiOperation({ summary: 'Remove item from cart' })
  async removeItem(
    @CurrentUser() user: JwtUser,
    @Param('itemId', UuidParamPipe) itemId: string,
  ) {
    return this.cartService.removeItem(itemId, user.id);
  }

  @Delete()
  @ApiOperation({ summary: 'Clear entire cart' })
  async clearCart(@CurrentUser() user: JwtUser) {
    return this.cartService.clearCart(user.id);
  }
}
