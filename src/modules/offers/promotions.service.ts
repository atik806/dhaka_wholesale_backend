import {
  BadRequestException,
  ConflictException,
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

/**
 * Version an admin's edit was based on: 'new' for a create, the row's
 * updated_at for an edit, or undefined for older clients (last write wins).
 */
export type ExpectedVersion = string | undefined;

const STALE_PROMOTION_MESSAGE =
  'This promotion was changed by someone else. Reload the page and try again.';

@Injectable()
export class PromotionsService {
  private readonly supabase = createSupabaseAdminClient();

  private async read<T>(
    prefix: string,
    parse: (value: unknown) => T,
  ): Promise<Array<{ value: T; updated_at: string }>> {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value, updated_at')
      .like('key', `${prefix}%`);
    if (error)
      throw new InternalServerErrorException('Failed to load promotions');
    try {
      return (data ?? []).map((row) => ({
        value: parse(row.value),
        updated_at: row.updated_at as string,
      }));
    } catch {
      throw new InternalServerErrorException('Invalid saved promotion');
    }
  }
  async combos() {
    return (
      await this.read('offer_combo_', (value) => ComboSchema.parse(value))
    ).map((row) => row.value);
  }
  async coupons() {
    return (
      await this.read('offer_coupon_', (value) => CouponSchema.parse(value))
    ).map((row) => row.value);
  }
  async activeCombos() {
    return (await this.combos()).filter((combo) =>
      promotionIsLive(combo, Date.now()),
    );
  }

  /** Orders (not cancelled) that used a coupon, optionally for one customer. */
  private async redemptions(code: string, userId?: string) {
    let query = this.supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_code', code)
      .neq('status', 'cancelled');
    if (userId) query = query.eq('user_id', userId);
    const { count, error } = await query;
    if (error)
      throw new InternalServerErrorException('Failed to check coupon usage');
    return count ?? 0;
  }

  /** Admin listing: each item with its version, coupons with their usage. */
  async managed() {
    const [combos, coupons] = await Promise.all([
      this.read('offer_combo_', (value) => ComboSchema.parse(value)),
      this.read('offer_coupon_', (value) => CouponSchema.parse(value)),
    ]);
    return {
      combos: combos.map((row) => ({
        ...row.value,
        updated_at: row.updated_at,
      })),
      coupons: await Promise.all(
        coupons.map(async (row) => ({
          ...row.value,
          updated_at: row.updated_at,
          redemptions: await this.redemptions(row.value.code),
        })),
      ),
    };
  }

  private async write(
    key: string,
    value: ComboDeal | Coupon,
    userId: string,
    expected: ExpectedVersion,
  ) {
    if (value.enabled && Date.parse(value.ends_at) <= Date.now())
      throw new BadRequestException('Choose an end time in the future');
    const row = {
      key,
      value,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (expected === 'new') {
      const { error } = await this.supabase.from('site_settings').insert(row);
      if (error?.code === '23505')
        throw new ConflictException(
          'A promotion with this code already exists. Reload the page and try again.',
        );
      if (error)
        throw new InternalServerErrorException('Failed to save promotion');
      return value;
    }

    if (expected !== undefined) {
      // Only overwrite the version this edit started from.
      const { data, error } = await this.supabase
        .from('site_settings')
        .update(row)
        .eq('key', key)
        .eq('updated_at', expected)
        .select('key')
        .maybeSingle();
      if (error)
        throw new InternalServerErrorException('Failed to save promotion');
      if (!data) throw new ConflictException(STALE_PROMOTION_MESSAGE);
      return value;
    }

    const { error } = await this.supabase
      .from('site_settings')
      .upsert(row, { onConflict: 'key' });
    if (error)
      throw new InternalServerErrorException('Failed to save promotion');
    return value;
  }
  async saveCombo(
    combo: ComboDeal,
    userId: string,
    expected?: ExpectedVersion,
  ) {
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
    return this.write(`offer_combo_${combo.id}`, combo, userId, expected);
  }
  async saveCoupon(coupon: Coupon, userId: string, expected?: ExpectedVersion) {
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
    return this.write(key, coupon, userId, expected);
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
  /**
   * Price lines with live combos and an optional coupon. With a userId, a
   * coupon that has reached its total or per-customer limit is rejected here
   * so the customer learns at once; place_order() re-checks under a lock.
   */
  async apply(lines: PromotionLine[], code?: string, userId?: string) {
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
      if (
        userId &&
        coupon.max_redemptions !== null &&
        (await this.redemptions(coupon.code)) >= coupon.max_redemptions
      )
        throw new BadRequestException(
          'This coupon has reached its usage limit',
        );
      if (
        userId &&
        coupon.per_customer_limit !== null &&
        (await this.redemptions(coupon.code, userId)) >=
          coupon.per_customer_limit
      )
        throw new BadRequestException(
          'You have already used this coupon the maximum number of times',
        );
    }
    return {
      ...calculatePromotions(lines, combos, coupon, Date.now()),
      coupon_limits: coupon
        ? {
            max_redemptions: coupon.max_redemptions,
            per_customer_limit: coupon.per_customer_limit,
          }
        : null,
    };
  }
}
