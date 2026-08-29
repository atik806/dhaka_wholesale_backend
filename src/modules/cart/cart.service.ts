import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type {
  AddCartItemDto,
  UpdateCartItemDto,
  MergeCartDto,
} from './dto/cart-item.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  availableStock,
  calculateShippingCost,
  calculateTax,
  roundMoney,
  type DeliveryZone,
} from '../../common/utils/commerce.js';

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);
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

    const stockQty = availableStock(product.stock_quantity, product.stock);
    if (stockQty <= 0) {
      throw new BadRequestException('Product is out of stock');
    }

    // `.eq(col, null)` sends `col=eq.null`, which never matches a SQL NULL — so
    // a no-variant product was never recognised as already in the cart. Match
    // NULLs with `.is()` and real values with `.eq()`. Postgres also treats
    // NULLs as distinct in the UNIQUE(user, product, size, color) index, so the
    // old bug could leave several no-variant rows for one product — fetch all
    // matches (oldest first) and collapse them here.
    let existingQuery = this.supabase
      .from('cart_items')
      .select('*')
      .eq('user_id', userId)
      .eq('product_id', dto.product_id)
      .order('created_at', { ascending: true });
    existingQuery = dto.selected_size
      ? existingQuery.eq('selected_size', dto.selected_size)
      : existingQuery.is('selected_size', null);
    existingQuery = dto.selected_color
      ? existingQuery.eq('selected_color', dto.selected_color)
      : existingQuery.is('selected_color', null);

    const { data: existingRows } = await existingQuery;
    const existing = existingRows?.[0];
    const currentQty = (existingRows ?? []).reduce(
      (sum, row) => sum + (row.quantity || 0),
      0,
    );

    const nextQty = currentQty + dto.quantity;
    if (nextQty > stockQty) {
      throw new BadRequestException(
        `Only ${stockQty} unit(s) available in stock`,
      );
    }

    if (existing) {
      // Drop any stale duplicate rows left by the old NULL-matching bug.
      const staleIds = (existingRows ?? []).slice(1).map((row) => row.id);
      if (staleIds.length > 0) {
        await this.supabase.from('cart_items').delete().in('id', staleIds);
      }

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
      .select('stock, stock_quantity')
      .eq('id', existing.product_id)
      .single();

    const stockQty = availableStock(product?.stock_quantity, product?.stock);
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
   *
   * Reads are batched (1 stock query + 1 existing-items query) instead of a
   * per-item round trip; inserts and updates are also batched.
   */
  async mergeItems(userId: string, dto: MergeCartDto) {
    const items = dto.items || [];
    const skipped: { product_id: string; reason: string }[] = [];

    if (items.length === 0) {
      const current = await this.findByUser(userId);
      return { items: current, merged_count: 0, skipped };
    }

    const productIds = [...new Set(items.map((i) => i.product_id))];

    // Batch stock lookup — single query for every item.
    const { data: products } = await this.supabase
      .from('products')
      .select('id, stock, stock_quantity')
      .in('id', productIds);

    const stockById = new Map(
      (products ?? []).map((p) => [p.id, p] as [string, any]),
    );

    // Batch existing cart items — single query instead of one per item.
    const { data: existingRows } = await this.supabase
      .from('cart_items')
      .select('*')
      .eq('user_id', userId)
      .in('product_id', productIds);

    const existingByKey = new Map<string, any>();
    for (const row of existingRows ?? []) {
      const key = `${row.product_id}|${row.selected_size ?? ''}|${row.selected_color ?? ''}`;
      existingByKey.set(key, row);
    }

    const updatesByQuantity = new Map<number, string[]>();
    const toInsert: Record<string, any>[] = [];
    let mergedCount = 0;

    for (const item of items) {
      const product = stockById.get(item.product_id);
      if (!product) {
        skipped.push({
          product_id: item.product_id,
          reason: 'Product not found',
        });
        continue;
      }

      const stockQty = availableStock(product.stock_quantity, product.stock);
      if (stockQty <= 0) {
        skipped.push({
          product_id: item.product_id,
          reason: 'Product is out of stock',
        });
        continue;
      }

      const key = `${item.product_id}|${item.selected_size ?? ''}|${item.selected_color ?? ''}`;
      const existing = existingByKey.get(key);

      if (existing) {
        const nextQty = Math.min(
          Math.max(existing.quantity, item.quantity),
          stockQty,
        );
        if (nextQty !== existing.quantity) {
          const ids = updatesByQuantity.get(nextQty) || [];
          ids.push(existing.id);
          updatesByQuantity.set(nextQty, ids);
        }
        mergedCount += 1;
      } else {
        toInsert.push({
          user_id: userId,
          product_id: item.product_id,
          quantity: Math.min(item.quantity, stockQty),
          selected_size: item.selected_size || null,
          selected_color: item.selected_color || null,
        });
        mergedCount += 1;
      }
    }

    // Batch all updates grouped by target quantity.
    for (const [quantity, ids] of updatesByQuantity) {
      const { error } = await this.supabase
        .from('cart_items')
        .update({ quantity })
        .in('id', ids);
      if (error) {
        skipped.push({
          product_id: ids[0],
          reason: 'Failed to update quantity',
        });
      }
    }

    // Batch all inserts in a single call.
    if (toInsert.length > 0) {
      const { error } = await this.supabase.from('cart_items').insert(toInsert);
      if (error) {
        this.logger.error(`Cart merge insert failed: ${error.message}`);
      }
    }

    const current = await this.findByUser(userId);
    return { items: current, merged_count: mergedCount, skipped };
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
