import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type {
  AddCartItemDto,
  UpdateCartItemDto,
  MergeCartDto,
} from './dto/cart-item.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  calculateShippingCost,
  calculateTax,
  roundMoney,
  type DeliveryZone,
} from '../../common/utils/commerce.js';

@Injectable()
export class CartService {
  private supabase = createSupabaseAdminClient();

  async findByUser(userId: string) {
    const { data, error } = await this.supabase
      .from('cart_items')
      .select(
        'id, user_id, product_id, quantity, selected_size, selected_color, created_at, products(id, name, slug, price, images, category_id, stock, stock_quantity, original_price, categories(name, slug))',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data || [];
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const { data: product } = await this.supabase
      .from('products')
      .select('stock, stock_quantity')
      .eq('id', dto.product_id)
      .single();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const stockQty = product.stock_quantity ?? 0;
    if (stockQty <= 0 || product.stock === 'out-of-stock') {
      throw new BadRequestException('Product is out of stock');
    }

    const { data: existing } = await this.supabase
      .from('cart_items')
      .select('*')
      .eq('user_id', userId)
      .eq('product_id', dto.product_id)
      .eq('selected_size', dto.selected_size || null)
      .eq('selected_color', dto.selected_color || null)
      .maybeSingle();

    const nextQty = (existing?.quantity || 0) + dto.quantity;
    if (nextQty > stockQty) {
      throw new BadRequestException(
        `Only ${stockQty} unit(s) available in stock`,
      );
    }

    if (existing) {
      const { data, error } = await this.supabase
        .from('cart_items')
        .update({ quantity: nextQty })
        .eq('id', existing.id)
        .select()
        .single();

      if (error)
        throw new InternalServerErrorException('An internal error occurred');
      return data;
    }

    const { data, error } = await this.supabase
      .from('cart_items')
      .insert({
        user_id: userId,
        product_id: dto.product_id,
        quantity: dto.quantity,
        selected_size: dto.selected_size || null,
        selected_color: dto.selected_color || null,
      })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data;
  }

  async updateItem(itemId: string, userId: string, dto: UpdateCartItemDto) {
    const { data: existing } = await this.supabase
      .from('cart_items')
      .select('product_id')
      .eq('id', itemId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existing) throw new NotFoundException('Cart item not found');

    const { data: product } = await this.supabase
      .from('products')
      .select('stock_quantity')
      .eq('id', existing.product_id)
      .single();

    const stockQty = product?.stock_quantity ?? 0;
    if (dto.quantity > stockQty) {
      throw new BadRequestException(
        `Only ${stockQty} unit(s) available in stock`,
      );
    }

    const { data, error } = await this.supabase
      .from('cart_items')
      .update({
        quantity: dto.quantity,
        selected_size: dto.selected_size || null,
        selected_color: dto.selected_color || null,
      })
      .eq('id', itemId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new NotFoundException('Cart item not found');
    return data;
  }

  async removeItem(itemId: string, userId: string) {
    const { error } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('id', itemId)
      .eq('user_id', userId);

    if (error) throw new NotFoundException('Cart item not found');
    return { message: 'Item removed from cart' };
  }

  async clearCart(userId: string) {
    const { error } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return { message: 'Cart cleared successfully' };
  }

  /**
   * Merge guest cart items into the authenticated user's cart.
   * Matching product + size + color rows take max(serverQty, guestQty)
   * so re-login with a local mirror of the server cart does not double quantities.
   */
  async mergeItems(userId: string, dto: MergeCartDto) {
    const merged: unknown[] = [];
    const skipped: { product_id: string; reason: string }[] = [];

    for (const item of dto.items) {
      try {
        const { data: product } = await this.supabase
          .from('products')
          .select('stock, stock_quantity')
          .eq('id', item.product_id)
          .single();

        if (!product) {
          skipped.push({
            product_id: item.product_id,
            reason: 'Product not found',
          });
          continue;
        }

        const stockQty = product.stock_quantity ?? 0;
        if (stockQty <= 0 || product.stock === 'out-of-stock') {
          skipped.push({
            product_id: item.product_id,
            reason: 'Product is out of stock',
          });
          continue;
        }

        const { data: existing } = await this.supabase
          .from('cart_items')
          .select('*')
          .eq('user_id', userId)
          .eq('product_id', item.product_id)
          .eq('selected_size', item.selected_size || null)
          .eq('selected_color', item.selected_color || null)
          .maybeSingle();

        if (existing) {
          const nextQty = Math.min(
            Math.max(existing.quantity, item.quantity),
            stockQty,
          );
          if (nextQty === existing.quantity) {
            merged.push(existing);
            continue;
          }
          const { data, error } = await this.supabase
            .from('cart_items')
            .update({ quantity: nextQty })
            .eq('id', existing.id)
            .select()
            .single();
          if (error) {
            skipped.push({
              product_id: item.product_id,
              reason: 'Failed to update quantity',
            });
            continue;
          }
          merged.push(data);
          continue;
        }

        const insertQty = Math.min(item.quantity, stockQty);
        const { data, error } = await this.supabase
          .from('cart_items')
          .insert({
            user_id: userId,
            product_id: item.product_id,
            quantity: insertQty,
            selected_size: item.selected_size || null,
            selected_color: item.selected_color || null,
          })
          .select()
          .single();

        if (error) {
          skipped.push({
            product_id: item.product_id,
            reason: 'Failed to insert item',
          });
          continue;
        }
        merged.push(data);
      } catch {
        skipped.push({ product_id: item.product_id, reason: 'skipped' });
      }
    }

    const items = await this.findByUser(userId);
    return {
      items,
      merged_count: merged.length,
      skipped,
    };
  }

  async getCartSummary(
    userId: string,
    deliveryZone: DeliveryZone = 'inside_dhaka',
  ) {
    const items = await this.findByUser(userId);

    const subtotal = items.reduce(
      (sum, item) => sum + ((item.products as any)?.price || 0) * item.quantity,
      0,
    );
    const shippingCost = calculateShippingCost(deliveryZone);
    const tax = calculateTax(subtotal);
    const total = subtotal + shippingCost + tax;

    return {
      items,
      delivery_zone: deliveryZone,
      subtotal: roundMoney(subtotal),
      shipping_cost: shippingCost,
      tax: roundMoney(tax),
      total: roundMoney(total),
    };
  }
}
