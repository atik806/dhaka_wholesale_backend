import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { CreateProductDto } from './dto/create-product.dto.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';
import type { QueryProductsDto } from './dto/query-products.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

/** Columns needed for list/grid cards — excludes heavy description text. */
const PRODUCT_LIST_SELECT =
  'id, slug, name, price, original_price, images, rating, review_count, stock, tags, sizes, colors, is_new, is_featured, created_at, category_id, categories(name, slug)';

const PRODUCT_DETAIL_SELECT = '*, categories(name, slug)';

@Injectable()
export class ProductsService {
  private supabase = createSupabaseAdminClient();

  async findAll(query: QueryProductsDto) {
    const {
      search,
      category,
      priceMin,
      priceMax,
      minRating,
      sort = 'popular',
      page = 1,
      limit = 12,
    } = query;

    // Inner join only when filtering by category so orphaned products still list
    const select = category
      ? 'id, slug, name, price, original_price, images, rating, review_count, stock, tags, sizes, colors, is_new, is_featured, created_at, category_id, categories!inner(name, slug)'
      : PRODUCT_LIST_SELECT;

    let dbQuery = this.supabase
      .from('products')
      .select(select, { count: 'exact' });

    if (category) {
      dbQuery = dbQuery.eq('categories.slug', category);
    }

    if (search) {
      const sanitized = search.replace(/[(),.]/g, '').slice(0, 200);
      const searchTerm = `%${sanitized}%`;
      dbQuery = dbQuery.or(
        `name.ilike.${searchTerm},description.ilike.${searchTerm},tags.cs.{${sanitized}}`,
      );
    }

    if (priceMin !== undefined) dbQuery = dbQuery.gte('price', priceMin);
    if (priceMax !== undefined) dbQuery = dbQuery.lte('price', priceMax);
    if (minRating !== undefined) dbQuery = dbQuery.gte('rating', minRating);

    if (query.ids && query.ids.length > 0) {
      dbQuery = dbQuery.in('id', query.ids);
    }

    switch (sort) {
      case 'newest':
        dbQuery = dbQuery.order('created_at', { ascending: false });
        break;
      case 'price-asc':
        dbQuery = dbQuery.order('price', { ascending: true });
        break;
      case 'price-desc':
        dbQuery = dbQuery.order('price', { ascending: false });
        break;
      case 'rating':
        dbQuery = dbQuery.order('rating', { ascending: false });
        break;
      default:
        dbQuery = dbQuery.order('review_count', { ascending: false });
        break;
    }

    const from = (page - 1) * limit;
    dbQuery = dbQuery.range(from, from + limit - 1);

    const { data, error, count } = await dbQuery;

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: count ? Math.ceil(count / limit) : 0,
      },
    };
  }

  async findBySlug(slug: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_DETAIL_SELECT)
      .eq('slug', slug)
      .single();

    if (error || !data) throw new NotFoundException('Product not found');
    return data;
  }

  async findByCategory(categorySlug: string, query: QueryProductsDto) {
    return this.findAll({ ...query, category: categorySlug });
  }

  async getFeatured() {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_LIST_SELECT)
      .eq('is_featured', true)
      .order('rating', { ascending: false })
      .limit(8);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data || [];
  }

  async getRelated(productId: string, categoryId: string, limit = 4) {
    const { data, error } = await this.supabase
      .from('products')
      .select(PRODUCT_LIST_SELECT)
      .eq('category_id', categoryId)
      .neq('id', productId)
      .order('rating', { ascending: false })
      .limit(limit);

    if (error)
      throw new InternalServerErrorException('An internal error occurred');
    return data || [];
  }

  /** Resolve related products without loading the full product payload. */
  async getRelatedBySlug(slug: string, limit = 4) {
    const { data: product, error } = await this.supabase
      .from('products')
      .select('id, category_id')
      .eq('slug', slug)
      .single();

    if (error || !product) throw new NotFoundException('Product not found');
    return this.getRelated(product.id, product.category_id, limit);
  }

  async getStockStats() {
    const [
      { count: total },
      { count: lowStock },
      { count: outOfStock },
    ] = await Promise.all([
      this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true }),
      this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('stock', 'low-stock'),
      this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('stock', 'out-of-stock'),
    ]);

    return {
      total: total || 0,
      lowStock: lowStock || 0,
      outOfStock: outOfStock || 0,
    };
  }

  async create(dto: CreateProductDto) {
    let slug = dto.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const { data: existing } = await this.supabase
      .from('products')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (existing) {
      const suffix = Date.now().toString(36);
      slug = `${slug}-${suffix}`;
    }

    const { data, error } = await this.supabase
      .from('products')
      .insert({ ...dto, slug })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    await this.recountCategoryProducts(dto.category_id);

    return data;
  }

  async update(id: string, dto: UpdateProductDto) {
    const updatedData: Record<string, any> = { ...dto };

    if (dto.name) {
      let newSlug = dto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

      const { data: existingSlug } = await this.supabase
        .from('products')
        .select('id')
        .eq('slug', newSlug)
        .neq('id', id)
        .maybeSingle();

      if (existingSlug) {
        const suffix = Date.now().toString(36);
        newSlug = `${newSlug}-${suffix}`;
      }

      updatedData.slug = newSlug;
    }

    const { data, error } = await this.supabase
      .from('products')
      .update(updatedData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new NotFoundException('Product not found');
    return data;
  }

  async remove(id: string) {
    const { data: product } = await this.supabase
      .from('products')
      .select('category_id')
      .eq('id', id)
      .single();

    const { error } = await this.supabase
      .from('products')
      .delete()
      .eq('id', id);
    if (error) throw new NotFoundException('Product not found');

    if (product?.category_id) {
      await this.recountCategoryProducts(product.category_id);
    }

    return { message: 'Product deleted successfully' };
  }

  private async recountCategoryProducts(categoryId: string) {
    try {
      const { count } = await this.supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('category_id', categoryId);

      await this.supabase
        .from('categories')
        .update({ product_count: count || 0 })
        .eq('id', categoryId);
    } catch {
      // Trigger handles this; ignore errors here
    }
  }
}
