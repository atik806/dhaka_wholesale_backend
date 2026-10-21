import { BadRequestException } from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { PromotionsService } from './promotions.service.js';
import type { ComboDeal, Coupon } from './promotions-pricing.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Combo and coupon persistence', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const combo: ComboDeal = {
    id: a,
    title: 'Combo',
    price: 150,
    enabled: true,
    starts_at: '2099-01-01T00:00:00Z',
    ends_at: '2099-01-02T00:00:00Z',
    products: [
      { product_id: a, quantity: 1 },
      { product_id: b, quantity: 1 },
    ],
  };
  const coupon: Coupon = {
    id: b,
    code: 'SAVE10',
    type: 'percentage',
    value: 10,
    enabled: true,
    starts_at: combo.starts_at,
    ends_at: combo.ends_at,
    minimum_spend: 0,
    maximum_discount: null,
    max_redemptions: null,
    per_customer_limit: null,
  };
  let rows: Map<string, unknown>;
  let service: PromotionsService;
  beforeEach(() => {
    rows = new Map();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(combo.starts_at));
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: (table: string) => {
        if (table === 'products')
          return {
            select: () => ({
              in: async (_key, ids: string[]) => ({
                data: ids
                  .filter((id) => id === a || id === b)
                  .map((id) => ({ id, price: 100 })),
                error: null,
              }),
            }),
          };
        if (table !== 'site_settings')
          throw new Error(`Unexpected table ${table}`);
        return {
          select: () => ({
            like: async (_key, pattern: string) => ({
              data: [...rows]
                .filter(([key]) => key.startsWith(pattern.slice(0, -1)))
                .map(([, value]) => ({ value })),
              error: null,
            }),
            eq: (_key, key: string) => ({
              maybeSingle: async () => ({
                data: rows.has(key) ? { value: rows.get(key) } : null,
                error: null,
              }),
            }),
          }),
          upsert: async ({ key, value }) => {
            rows.set(key, structuredClone(value));
            return { error: null };
          },
          delete: () => ({
            eq: async (_key, key: string) => {
              rows.delete(key);
              return { error: null };
            },
          }),
        };
      },
    } as never);
    service = new PromotionsService();
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates, edits, pauses and deletes a combo without changing product rows', async () => {
    await service.saveCombo(combo, 'admin');
    expect((await service.activeCombos())[0].price).toBe(150);
    await service.saveCombo({ ...combo, price: 140 }, 'admin');
    expect((await service.combos())[0].price).toBe(140);
    await service.saveCombo({ ...combo, enabled: false }, 'admin');
    expect(await service.activeCombos()).toEqual([]);
    await service.removeCombo(a);
    expect(await service.combos()).toEqual([]);
  });
  it('rejects nonexistent products and non-discounted combo prices', async () => {
    await expect(
      service.saveCombo({ ...combo, price: 200 }, 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.saveCombo(
        {
          ...combo,
          products: [
            { product_id: a, quantity: 1 },
            { product_id: 'missing', quantity: 1 },
          ],
        },
        'admin',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.size).toBe(0);
  });
  it('creates, edits, validates case-insensitive codes, and deletes coupons', async () => {
    await service.saveCoupon(coupon, 'admin');
    expect(
      (
        await service.apply(
          [{ product_id: a, price: 100, quantity: 1 }],
          ' save10 ',
        )
      ).subtotal,
    ).toBe(90);
    await service.saveCoupon({ ...coupon, value: 20 }, 'admin');
    expect(
      (
        await service.apply(
          [{ product_id: a, price: 100, quantity: 1 }],
          'SAVE10',
        )
      ).subtotal,
    ).toBe(80);
    await service.removeCoupon(b);
    await expect(
      service.apply([{ product_id: a, price: 100, quantity: 1 }], 'SAVE10'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects duplicate coupon codes and renaming existing codes', async () => {
    await service.saveCoupon(coupon, 'admin');
    await expect(
      service.saveCoupon({ ...coupon, id: a }, 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.saveCoupon({ ...coupon, code: 'RENAMED' }, 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.coupons()).map((item) => item.code)).toEqual([
      'SAVE10',
    ]);
  });
  it('rejects paused coupons at checkout even if a customer retained the code', async () => {
    await service.saveCoupon({ ...coupon, enabled: false }, 'admin');
    await expect(
      service.apply([{ product_id: a, price: 100, quantity: 1 }], 'SAVE10'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
