import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import type {
  CreateReviewDto,
  UpdateReviewDto,
} from './dto/create-review.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class ReviewsService {
  private supabase = createSupabaseAdminClient();

  async findRecent(limit = 6) {
    const { data, error } = await this.supabase
      .from('reviews')
      .select(
        'id, rating, text, created_at, product_id, user_id, profiles(name, avatar_url), products(name, slug, images)',
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data || [];
  }

  async findByProduct(productId: string, page = 1, limit = 20) {
    const from = (page - 1) * limit;
    const { data, error, count } = await this.supabase
      .from('reviews')
      .select('*, profiles(name, avatar_url)', { count: 'exact' })
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async create(userId: string, productId: string, dto: CreateReviewDto) {
    const { data: existing } = await this.supabase
      .from('reviews')
      .select('id')
      .eq('product_id', productId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing)
      throw new ForbiddenException('You have already reviewed this product');

    const { data, error } = await this.supabase
      .from('reviews')
      .insert({
        product_id: productId,
        user_id: userId,
        rating: dto.rating,
        text: dto.text,
      })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data;
  }

  async update(reviewId: string, userId: string, dto: UpdateReviewDto) {
    const { data: review } = await this.supabase
      .from('reviews')
      .select('user_id, product_id')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review not found');
    if (review.user_id !== userId)
      throw new ForbiddenException('You can only edit your own reviews');

    const { data, error } = await this.supabase
      .from('reviews')
      .update(dto)
      .eq('id', reviewId)
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data;
  }

  async remove(reviewId: string, userId: string) {
    const { data: review } = await this.supabase
      .from('reviews')
      .select('user_id, product_id')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review not found');
    if (review.user_id !== userId)
      throw new ForbiddenException('You can only delete your own reviews');

    const { error } = await this.supabase
      .from('reviews')
      .delete()
      .eq('id', reviewId);
    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return { message: 'Review deleted successfully' };
  }
}
