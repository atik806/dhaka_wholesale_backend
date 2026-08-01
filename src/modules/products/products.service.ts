import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { CreateProductDto } from './dto/create-product.dto.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';
import type { QueryProductsDto } from './dto/query-products.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { CategoriesService } from '../categories/categories.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import {
  deriveStockStatus,
  resolveStockQuantity,
} from '../../common/utils/commerce.js';

/** Columns needed for list/grid cards — excludes heavy description text. */
const PRODUCT_LIST_SELECT =
  'id, slug, name, price, original_price, images, rating, review_count, stock, stock_quantity, tags, sizes, colors, is_new, is_featured, created_at, category_id, categories(name, slug)';

const PRODUCT_DETAIL_SELECT = '*, categories(name, slug)';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private supabase = createSupabaseAdminClient();

  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly cacheStore: CacheStore,
  ) {}

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

    let resolvedCategoryIds: string[] | null = null;
    if (category) {
      const { data: cat } = await this.supabase
        .from('categories')
        .select('id')
        .eq('slug', category)
        .maybeSingle();

      if (cat) {
        resolvedCategoryIds = [cat.id];
        const childIds = await this.categoriesService.getChildIds(cat.id);
        if (childIds.length > 0) {
          resolvedCategoryIds = [...resolvedCategoryIds, ...childIds];
        }
      }
    }

    let dbQuery = this.supabase
      .from('products')
      .select(PRODUCT_LIST_SELECT, { count: 'exact' });

    if (resolvedCategoryIds && resolvedCategoryIds.length > 0) {
      dbQuery = dbQuery.in('category_id', resolvedCategoryIds);
    } else if (
      category &&
      (!resolvedCategoryIds || resolvedCategoryIds.length === 0)
    ) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
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
    // Aggregate per stock status with a GROUP BY (returns at most 3 rows).
    const query = this.supabase.from('products').select('stock, count(*)');
    const { data, error } = (await query) as unknown as {
      data: { stock: string; count: string | number }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const n = Number(row.count) || 0;
      counts.set(row.stock, (counts.get(row.stock) ?? 0) + n);
    }

    return {
      total:
        (counts.get('in-stock') ?? 0) +
        (counts.get('low-stock') ?? 0) +
        (counts.get('out-of-stock') ?? 0),
      lowStock: counts.get('low-stock') ?? 0,
      outOfStock: counts.get('out-of-stock') ?? 0,
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

    const stock_quantity = resolveStockQuantity(
      dto.stock_quantity,
      dto.stock ?? 'in-stock',
    );
    const stock = deriveStockStatus(stock_quantity);

    const { data, error } = await this.supabase
      .from('products')
      .insert({ ...dto, slug, stock_quantity, stock })
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Product create failed: ${error.message} (${error.code})`,
      );
      throw new InternalServerErrorException('An internal error occurred');
    }

    this.invalidateProductCaches();
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

    if (dto.stock_quantity !== undefined) {
      updatedData.stock_quantity = dto.stock_quantity;
      updatedData.stock = deriveStockStatus(dto.stock_quantity);
    } else if (dto.stock !== undefined) {
      // Legacy enum-only updates still sync a sensible quantity
      updatedData.stock_quantity = resolveStockQuantity(undefined, dto.stock);
      updatedData.stock = dto.stock;
    }

    const { data, error } = await this.supabase
      .from('products')
      .update(updatedData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new NotFoundException('Product not found');

    this.invalidateProductCaches();
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase
      .from('products')
      .delete()
      .eq('id', id);
    if (error) throw new NotFoundException('Product not found');

    this.invalidateProductCaches();
    return { message: 'Product deleted successfully' };
  }

  private invalidateProductCaches(): void {
    this.cacheStore.deleteByPrefix('GET:/products');
    this.cacheStore.deleteByPrefix('GET:/categories');
  }
}
