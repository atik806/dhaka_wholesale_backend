import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import {
  activeSalePrices,
  applySalePrice,
  FlashSaleSchema,
  type FlashSale,
  type PricedProduct,
} from './offer-pricing.js';

@Injectable()
export class OffersService {
  private readonly supabase = createSupabaseAdminClient();

  constructor(private readonly cacheStore: CacheStore) {}

  async get(): Promise<FlashSale | null> {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'flash_sale')
      .maybeSingle();
    if (error)
      throw new InternalServerErrorException('Failed to load flash sale');
    if (!data) return null;
    const result = FlashSaleSchema.safeParse(data.value);
    if (!result.success)
      throw new InternalServerErrorException('Invalid stored flash sale');
    return result.data;
  }

  async prices(): Promise<Map<string, number>> {
    const sale = await this.get();
    return activeSalePrices(sale, Date.now());
  }

  async priceProducts<T extends PricedProduct>(products: T[]) {
    const prices = await this.prices();
    return products.map((product) => applySalePrice(product, prices));
  }

  async save(sale: FlashSale, userId: string) {
    if (sale.enabled && Date.parse(sale.ends_at) <= Date.now()) {
      throw new BadRequestException('Choose an end time in the future');
    }
    const { data, error } = await this.supabase
      .from('products')
      .select('id, name, price')
      .in(
        'id',
        sale.products.map((item) => item.product_id),
      );
    if (error)
      throw new InternalServerErrorException('Failed to verify sale products');
    const products = new Map(
      (data ?? []).map((product) => [product.id, product]),
    );
    for (const item of sale.products) {
      const product = products.get(item.product_id);
      if (!product)
        throw new BadRequestException(
          'A selected product no longer exists. Reload and try again.',
        );
      if (item.price >= Number(product.price)) {
        throw new BadRequestException(
          `Sale price must be below the current price of ${product.name}`,
        );
      }
    }
    // One database statement publishes the complete offer. Product rows stay untouched.
    const { error: saveError } = await this.supabase
      .from('site_settings')
      .upsert(
        {
          key: 'flash_sale',
          value: sale,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );
    if (saveError)
      throw new InternalServerErrorException('Failed to save flash sale');
    this.cacheStore.deleteByPrefix('GET:/products');
    return sale;
  }

  async end(userId: string) {
    const sale = await this.get();
    if (!sale) return { enabled: false };
    const { error } = await this.supabase
      .from('site_settings')
      .update({
        value: { ...sale, enabled: false },
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'flash_sale');
    if (error)
      throw new InternalServerErrorException('Failed to end flash sale');
    this.cacheStore.deleteByPrefix('GET:/products');
    return { enabled: false };
  }
}
