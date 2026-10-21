import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { CheckoutQuoteDto } from './dto/checkout-quote.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { OffersService } from '../offers/offers.service.js';
import { PromotionsService } from '../offers/promotions.service.js';
import {
  availableStock,
  calculateShippingCost,
  calculateTax,
  roundMoney,
} from '../../common/utils/commerce.js';

@Injectable()
export class CheckoutService {
  private supabase = createSupabaseAdminClient();
  constructor(
    private readonly offers: OffersService,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * Server-side pricing source of truth for checkout.
   * Returns subtotal, zone shipping, tax (0), and total.
   */
  async quote(userId: string, dto: CheckoutQuoteDto) {
    const lines = await this.resolveLines(userId, dto.items);
    const promotion = await this.promotions.apply(
      lines,
      dto.coupon_code,
      userId,
    );
    const subtotal = promotion.subtotal;
    const shippingCost = calculateShippingCost(dto.delivery_zone);
    const tax = calculateTax(subtotal);
    const total = roundMoney(subtotal + shippingCost + tax);

    const unavailable = lines.filter((l) => !l.available);

    return {
      delivery_zone: dto.delivery_zone,
      subtotal,
      shipping_cost: shippingCost,
      tax,
      total,
      currency: 'BDT',
      original_subtotal: promotion.original_subtotal,
      discount_total: promotion.discount_total,
      combo_discount: promotion.combo_discount,
      coupon_discount: promotion.coupon_discount,
      applied_combos: promotion.applied_combos,
      coupon_code: promotion.coupon_code,
      items: lines.map((line, index) => ({
        ...line,
        line_total: promotion.line_totals[index],
      })),
      can_checkout: unavailable.length === 0,
      unavailable_items: unavailable.map((l) => ({
        product_id: l.product_id,
        name: l.name,
        requested: l.quantity,
        stock_quantity: l.stock_quantity,
      })),
    };
  }

  private async resolveLines(
    userId: string,
    items?: Array<{ product_id: string; quantity: number }>,
  ) {
    if (items && items.length > 0) {
      return this.quoteFromItems(items);
    }
    return this.quoteFromCart(userId);
  }

  private async quoteFromCart(userId: string) {
    const { data: cartItems, error } = await this.supabase
      .from('cart_items')
      .select(
        'product_id, quantity, products(id, name, price, stock_quantity, stock)',
      )
      .eq('user_id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to load cart');
    }
    if (!cartItems || cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const prices = await this.offers.prices();
    return cartItems.map((item) => {
      const product = item.products as unknown as {
        id: string;
        name: string;
        price: number;
        stock_quantity: number | null;
        stock: string;
      } | null;
      if (product)
        product.price = Math.min(
          product.price,
          prices.get(product.id) ?? product.price,
        );
      const stockQty = availableStock(product?.stock_quantity, product?.stock);
      const qty = item.quantity;
      return {
        product_id: item.product_id,
        name: product?.name || '',
        price: product?.price || 0,
        quantity: qty,
        line_total: roundMoney((product?.price || 0) * qty),
        stock_quantity: stockQty,
        available: stockQty >= qty && stockQty > 0,
      };
    });
  }

  private async quoteFromItems(
    items: Array<{ product_id: string; quantity: number }>,
  ) {
    const productIds = items.map((i) => i.product_id);
    const { data: products, error } = await this.supabase
      .from('products')
      .select('id, name, price, stock_quantity, stock')
      .in('id', productIds);

    if (error) {
      throw new InternalServerErrorException('Failed to verify products');
    }
    if (!products || products.length === 0) {
      throw new BadRequestException('One or more products are invalid');
    }

    const pricedProducts = await this.offers.priceProducts(products);
    const productMap = new Map(pricedProducts.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !productMap.has(id));
    if (missing.length > 0) {
      throw new BadRequestException('One or more products are invalid');
    }

    // Aggregate duplicate product_ids for stock checks
    const qtyByProduct = new Map<string, number>();
    for (const item of items) {
      qtyByProduct.set(
        item.product_id,
        (qtyByProduct.get(item.product_id) || 0) + item.quantity,
      );
    }

    return items.map((item) => {
      const product = productMap.get(item.product_id)!;
      const stockQty = availableStock(product.stock_quantity, product.stock);
      const totalRequested = qtyByProduct.get(item.product_id) || item.quantity;
      return {
        product_id: item.product_id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        line_total: roundMoney(product.price * item.quantity),
        stock_quantity: stockQty,
        available: stockQty >= totalRequested && stockQty > 0,
      };
    });
  }
}
