import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { CheckoutQuoteDto } from './dto/checkout-quote.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  calculateShippingCost,
  calculateTax,
  roundMoney,
} from '../../common/utils/commerce.js';

@Injectable()
export class CheckoutService {
  private supabase = createSupabaseAdminClient();

  /**
   * Server-side pricing source of truth for checkout.
   * Returns subtotal, zone shipping, tax (0), and total.
   */
  async quote(userId: string, dto: CheckoutQuoteDto) {
    const lines = await this.resolveLines(userId, dto.items);
    const subtotal = roundMoney(
      lines.reduce((sum, line) => sum + line.price * line.quantity, 0),
    );
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
      items: lines,
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
      .select('product_id, quantity, products(id, name, price, stock_quantity, stock)')
      .eq('user_id', userId);

    if (error) {
      throw new InternalServerErrorException('Failed to load cart');
    }
    if (!cartItems || cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    return cartItems.map((item) => {
      const product = item.products as unknown as {
        id: string;
        name: string;
        price: number;
        stock_quantity: number | null;
        stock: string;
      } | null;
      const stockQty = product?.stock_quantity ?? 0;
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

    const productMap = new Map(products.map((p) => [p.id, p]));
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
      const stockQty = product.stock_quantity ?? 0;
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
