import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import {
  calculatePromotions,
  ComboSchema,
  CouponSchema,
  promotionIsLive,
  type ComboDeal,
  type Coupon,
  type PromotionLine,
} from './promotions-pricing.js';

@Injectable()
export class PromotionsService {
  private readonly supabase = createSupabaseAdminClient();

  private async read<T>(
    prefix: string,
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value')
      .like('key', `${prefix}%`);
    if (error)
      throw new InternalServerErrorException('Failed to load promotions');
    try {
      return (data ?? []).map((row) => parse(row.value));
    } catch {
      throw new InternalServerErrorException('Invalid saved promotion');
    }
  }
  combos() {
    return this.read('offer_combo_', (value) => ComboSchema.parse(value));
  }
  coupons() {
    return this.read('offer_coupon_', (value) => CouponSchema.parse(value));
  }
  async activeCombos() {
    return (await this.combos()).filter((combo) =>
      promotionIsLive(combo, Date.now()),
    );
  }

  private async write(key: string, value: ComboDeal | Coupon, userId: string) {
    if (value.enabled && Date.parse(value.ends_at) <= Date.now())
      throw new BadRequestException('Choose an end time in the future');
    const { error } = await this.supabase
      .from('site_settings')
      .upsert(
        {
          key,
          value,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );
    if (error)
      throw new InternalServerErrorException('Failed to save promotion');
    return value;
  }
  async saveCombo(combo: ComboDeal, userId: string) {
    const { data, error } = await this.supabase
      .from('products')
      .select('id, price')
      .in(
        'id',
        combo.products.map((item) => item.product_id),
      );
    if (error)
      throw new InternalServerErrorException('Failed to verify combo products');
    const products = new Map(
      (data ?? []).map((product) => [product.id, product]),
    );
    if (products.size !== combo.products.length)
      throw new BadRequestException(
        'One or more combo products no longer exist',
      );
    const normal = combo.products.reduce(
      (sum, item) =>
        sum + Number(products.get(item.product_id)!.price) * item.quantity,
      0,
    );
    if (combo.price >= normal)
      throw new BadRequestException(
        'Combo price must be below the total normal price',
      );
    return this.write(`offer_combo_${combo.id}`, combo, userId);
  }
  async saveCoupon(coupon: Coupon, userId: string) {
    // A normalized code is the unique database key; simultaneous creates cannot create duplicate codes.
    const key = `offer_coupon_${coupon.code}`;
    const all = await this.coupons();
    const previous = all.find((item) => item.id === coupon.id);
    if (previous && previous.code !== coupon.code)
      throw new BadRequestException(
        'Coupon codes cannot be renamed. Create a new code instead.',
      );
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error)
      throw new InternalServerErrorException('Failed to verify coupon code');
    if (data && data.value.id !== coupon.id)
      throw new BadRequestException('That coupon code already exists');
    return this.write(key, coupon, userId);
  }
  async removeCombo(id: string) {
    return this.remove(`offer_combo_${id}`);
  }
  async removeCoupon(id: string) {
    const coupon = (await this.coupons()).find((item) => item.id === id);
    if (!coupon) throw new NotFoundException('Coupon not found');
    return this.remove(`offer_coupon_${coupon.code}`);
  }
  private async remove(key: string) {
    const { error } = await this.supabase
      .from('site_settings')
      .delete()
      .eq('key', key);
    if (error)
      throw new InternalServerErrorException('Failed to delete promotion');
    return { deleted: true };
  }
  async apply(lines: PromotionLine[], code?: string) {
    const combos = await this.combos();
    let coupon: Coupon | null = null;
    if (code) {
      const normalized = code.trim().toUpperCase();
      const { data, error } = await this.supabase
        .from('site_settings')
        .select('value')
        .eq('key', `offer_coupon_${normalized}`)
        .maybeSingle();
      if (error)
        throw new InternalServerErrorException('Failed to verify coupon');
      if (!data) throw new BadRequestException('Coupon code is invalid');
      const result = CouponSchema.safeParse(data.value);
      if (!result.success)
        throw new BadRequestException('Coupon code is invalid');
      coupon = result.data;
    }
    return calculatePromotions(lines, combos, coupon, Date.now());
  }
}
