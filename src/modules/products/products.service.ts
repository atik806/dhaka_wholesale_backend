import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { CreateProductDto } from './dto/create-product.dto.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';
import type { QueryProductsDto } from './dto/query-products.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { CategoriesService } from '../categories/categories.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import { OffersService } from '../offers/offers.service.js';
import { applySalePrice } from '../offers/offer-pricing.js';
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
    private readonly offers: OffersService,
  ) {}

  async findAll(query: QueryProductsDto) {
    const {
      search,
      category,
      categories,
      priceMin,
      priceMax,
      minRating,
      sort = 'popular',
      page = 1,
      limit = 12,
    } = query;

    // Resolve one or more category slugs to category ids (children included)
    // so the filter happens server-side. This keeps pagination and totals
    // correct for multi-category selection — the client must never fetch a
    // single page of the whole catalog and filter locally (that silently
    // truncates results and breaks page counts).
    let resolvedCategoryIds: string[] | null = null;
    const slugs = categories?.length ? categories : category ? [category] : [];
    if (slugs.length > 0) {
      const ids = new Set<string>();
      for (const slug of slugs) {
        const { data: cat } = await this.supabase
          .from('categories')
          .select('id')
          .eq('slug', slug)
          .maybeSingle();

        if (cat) {
          ids.add(cat.id);
          const childIds = await this.categoriesService.getChildIds(cat.id);
          childIds.forEach((childId) => ids.add(childId));
        }
      }
      resolvedCategoryIds = [...ids];
    }

    if (slugs.length > 0 && !resolvedCategoryIds?.length) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }

    // Split offered products from regular products so filtering, sorting and
    // pagination use effective prices without loading the entire catalog.
    const prices = await this.offers.prices();
    if (query.onSale && prices.size === 0) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    const makeQuery = (filterPrice: boolean) => {
      let dbQuery = this.supabase
        .from('products')
        .select(PRODUCT_LIST_SELECT, { count: 'exact' });
      if (resolvedCategoryIds?.length)
        dbQuery = dbQuery.in('category_id', resolvedCategoryIds);
      if (query.onSale) dbQuery = dbQuery.in('id', [...prices.keys()]);
      if (search) {
        // Only plain words, spaces and hyphens survive. Everything else
        // is stripped so the user-supplied term can never smuggle an
        // operator (and, or, NOT, =, etc.) into the PostgREST filter.
        const sanitized = search
          .replace(/[^\p{L}\p{N}\s-]/gu, '')
          .trim()
          .slice(0, 120);
        const searchTerm = `%${sanitized}%`;
        dbQuery = dbQuery.or(
          `name.ilike.${searchTerm},description.ilike.${searchTerm},tags.cs.{${sanitized}}`,
        );
      }

      if (filterPrice && priceMin !== undefined)
        dbQuery = dbQuery.gte('price', priceMin);
      if (filterPrice && priceMax !== undefined)
        dbQuery = dbQuery.lte('price', priceMax);
      if (minRating !== undefined) dbQuery = dbQuery.gte('rating', minRating);

      if (query.ids && query.ids.length > 0) {
        dbQuery = dbQuery.in('id', query.ids);
      }

      return dbQuery;
    };
    const sortColumn =
      sort === 'newest'
        ? 'created_at'
        : sort.startsWith('price-')
          ? 'price'
          : sort === 'rating'
            ? 'rating'
            : 'review_count';
    const ascending = sort === 'price-asc';
    const ordered = (dbQuery: ReturnType<typeof makeQuery>) =>
      dbQuery
        .order(sortColumn, { ascending, nullsFirst: false })
        .order('id', { ascending: true });
    const from = (page - 1) * limit;
    if (prices.size > 0) {
      const ids = [...prices.keys()];
      const baseStart = Math.max(0, from - ids.length);
      const [regular, offered] = await Promise.all([
        ordered(makeQuery(true).not('id', 'in', `(${ids.join(',')})`)).range(
          baseStart,
          from + limit - 1,
        ),
        makeQuery(false).in('id', ids).range(0, 199),
      ]);
      if (regular.error || offered.error)
        throw new InternalServerErrorException('Failed to load products');
      const saleProducts = (offered.data ?? [])
        .map((product) => applySalePrice(product, prices))
        .filter(
          (product) => !query.onSale || product.price < product.base_price,
        )
        .filter(
          (product) =>
            (priceMin === undefined || product.price >= priceMin) &&
            (priceMax === undefined || product.price <= priceMax),
        );
      const merged = [
        ...(regular.data ?? []).map((product) =>
          applySalePrice(product, prices),
        ),
        ...saleProducts,
      ];
      merged.sort((a, b) => {
        const av = a[sortColumn];
        const bv = b[sortColumn];
        if (av == null && bv != null) return 1;
        if (bv == null && av != null) return -1;
        const comparison = av! < bv! ? -1 : av! > bv! ? 1 : 0;
        return (
          (ascending ? comparison : -comparison) || a.id.localeCompare(b.id)
        );
      });
      const total = (regular.count ?? 0) + saleProducts.length;
      return {
        data: merged.slice(from - baseStart, from - baseStart + limit),
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
    const { data, error, count } = await ordered(makeQuery(true)).range(
      from,
      from + limit - 1,
    );
    if (error)
      throw new InternalServerErrorException('Failed to load products');
    return {
      data: (data ?? []).map((product) => applySalePrice(product, prices)),
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
    return (await this.offers.priceProducts([data]))[0];
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
    return this.offers.priceProducts(data || []);
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
    return this.offers.priceProducts(data || []);
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
    // PostgREST rejects aggregates such as `count(*)` unless they are enabled
    // on the server (PGRST123), so count each status with a head request.
    const statuses = ['in-stock', 'low-stock', 'out-of-stock'] as const;
    const results = await Promise.all(
      statuses.map((stock) =>
        this.supabase
          .from('products')
          .select('id', { count: 'exact', head: true })
          .eq('stock', stock),
      ),
    );

    if (results.some((result) => result.error))
      throw new InternalServerErrorException('An internal error occurred');

    const [inStock, lowStock, outOfStock] = results.map(
      (result) => result.count ?? 0,
    );

    return {
      total: inStock + lowStock + outOfStock,
      lowStock,
      outOfStock,
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

    // The admin form sends the name on every save. Only a real rename gets a
    // new slug: regenerating it on each save broke shared product links.
    const { data: current } = dto.name
      ? await this.supabase
          .from('products')
          .select('name')
          .eq('id', id)
          .maybeSingle()
      : { data: null };
    if (dto.name && dto.name.trim() !== current?.name?.trim()) {
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
      // Legacy label-only update (older admin form). Resending the label the
      // product already has must not touch the real count; only an actual
      // label change falls back to a nominal quantity for that level.
      const { data: current } = await this.supabase
        .from('products')
        .select('stock_quantity')
        .eq('id', id)
        .single();
      const currentQty = Math.max(0, Math.floor(current?.stock_quantity ?? 0));
      delete updatedData.stock;
      if (deriveStockStatus(currentQty) !== dto.stock) {
        updatedData.stock_quantity = resolveStockQuantity(undefined, dto.stock);
        updatedData.stock = dto.stock;
      }
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
    if (error) {
      // order_items.product_id is ON DELETE RESTRICT, so a product that
      // has been ordered cannot be deleted. That's a conflict, not a
      // missing row.
      if (error.code === '23503') {
        throw new ConflictException(
          'Product cannot be deleted because it has been ordered',
        );
      }
      this.logger.error(`Failed to delete product ${id}: ${error.message}`);
      throw new InternalServerErrorException('Failed to delete product');
    }

    this.invalidateProductCaches();
    return { message: 'Product deleted successfully' };
  }

  private invalidateProductCaches(): void {
    this.cacheStore.deleteByPrefix('GET:/products');
    this.cacheStore.deleteByPrefix('GET:/categories');
  }
}
