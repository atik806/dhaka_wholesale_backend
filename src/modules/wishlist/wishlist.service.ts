import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AddWishlistDto, MergeWishlistDto } from './dto/wishlist.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class WishlistService {
  private supabase = createSupabaseAdminClient();

  async findByUser(userId: string) {
    const { data, error } = await this.supabase
      .from('wishlists')
      .select(
        'id, user_id, product_id, created_at, products(id, name, slug, price, images, category_id, stock, original_price, rating, review_count, is_new, categories(name, slug))',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data || [];
  }

  async addItem(userId: string, dto: AddWishlistDto) {
    const { data: existing } = await this.supabase
      .from('wishlists')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', dto.product_id)
      .maybeSingle();

    if (existing) return { message: 'Product already in wishlist' };

    const { data, error } = await this.supabase
      .from('wishlists')
      .insert({ user_id: userId, product_id: dto.product_id })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data;
  }

  async removeItem(userId: string, productId: string) {
    const { error } = await this.supabase
      .from('wishlists')
      .delete()
      .eq('user_id', userId)
      .eq('product_id', productId);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return { message: 'Removed from wishlist' };
  }

  async checkItem(userId: string, productId: string) {
    const { data, error } = await this.supabase
      .from('wishlists')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return { isInWishlist: !!data };
  }

  /**
   * Merge guest wishlist product IDs into the authenticated user's wishlist.
   * Existing product rows are skipped (idempotent).
   */
  async mergeItems(userId: string, dto: MergeWishlistDto) {
    const uniqueIds = [...new Set(dto.product_ids)];
    let added = 0;

    for (const productId of uniqueIds) {
      const result = await this.addItem(userId, { product_id: productId });
      if (result && typeof result === 'object' && 'id' in result) {
        added += 1;
      }
    }

    const items = await this.findByUser(userId);
    return {
      items,
      added_count: added,
      total: items.length,
    };
  }
}
