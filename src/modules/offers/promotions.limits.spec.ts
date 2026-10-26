import { BadRequestException, ConflictException } from '@nestjs/common';
import { PromotionsService } from './promotions.service.js';
import { CouponSchema, type Coupon } from './promotions-pricing.js';
import { OrdersService } from '../orders/orders.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import type { OffersService } from './offers.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

type Filter = [string, string, unknown];

const userId = '00000000-0000-4000-8000-0000000000aa';
const adminId = '00000000-0000-4000-8000-0000000000ad';
const now = Date.parse('2026-10-21T12:00:00Z');
const coupon: Coupon = CouponSchema.parse({
  id: '00000000-0000-4000-8000-0000000000c1',
  code: 'WELCOME10',
  enabled: true,
  starts_at: new Date(now - 86_400_000).toISOString(),
  ends_at: new Date(now + 86_400_000).toISOString(),
  type: 'percentage',
  value: 10,
  max_redemptions: 1,
  per_customer_limit: 1,
});
const lines = [
  {
    product_id: '00000000-0000-4000-8000-000000000001',
    price: 200,
    quantity: 1,
  },
];

/**
 * Supabase stand-in: site_settings rows by key, and an orders head-count
 * whose result depends on whether the query is scoped to one user.
 */
function mockSupabase(options: {
  settings?: Record<string, { value: unknown; updated_at: string }>;
  totalUses?: number;
  customerUses?: number;
  updateResult?: unknown;
  insertError?: { code: string; message: string } | null;
}) {
  const writes: { op: string; value?: unknown; filters: Filter[] }[] = [];
  const from = (table: string) => {
    const filters: Filter[] = [];
    let op = 'select';
    let payload: unknown;
    const chain: Record<string, unknown> = {};
    const record = (name: string) => (column: string, value: unknown) => {
      filters.push([name, column, value]);
      return chain;
    };
    chain.select = () => chain;
    chain.eq = record('eq');
    chain.neq = record('neq');
    chain.like = record('like');
    chain.update = (value: unknown) => {
      op = 'update';
      payload = value;
      return chain;
    };
    chain.insert = (value: unknown) => {
      op = 'insert';
      payload = value;
      writes.push({ op, value, filters });
      return Promise.resolve({ error: options.insertError ?? null });
    };
    const settingsRows = () =>
      Object.entries(options.settings ?? {}).map(([key, row]) => ({
        key,
        ...row,
      }));
    const keyFilter = () => filters.find(([, column]) => column === 'key')?.[2];
    chain.maybeSingle = () => {
      if (op === 'update') {
        writes.push({ op, value: payload, filters });
        return Promise.resolve({
          data: options.updateResult ?? null,
          error: null,
        });
      }
      const row = settingsRows().find((r) => r.key === keyFilter());
      return Promise.resolve({ data: row ?? null, error: null });
    };
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (table === 'orders') {
        const scoped = filters.some(([, column]) => column === 'user_id');
        return Promise.resolve(
          resolve({
            count: scoped
              ? (options.customerUses ?? 0)
              : (options.totalUses ?? 0),
            error: null,
          }),
        );
      }
      const prefix = filters.find(([name]) => name === 'like')?.[2];
      const rows = settingsRows().filter(
        (row) =>
          typeof prefix !== 'string' ||
          row.key.startsWith(prefix.replace(/%$/, '')),
      );
      return Promise.resolve(resolve({ data: rows, error: null }));
    };
    return chain;
  };
  jest.mocked(createSupabaseAdminClient).mockReturnValue({ from } as never);
  return writes;
}

const settingsFor = (
  value: Coupon,
  updated_at = '2026-10-21T10:00:00.000+00:00',
) => ({
  [`offer_coupon_${value.code}`]: { value, updated_at },
});

describe('coupon limits', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());

  it('keeps coupons saved before limits existed unlimited', () => {
    const legacy = CouponSchema.parse({
      ...coupon,
      max_redemptions: undefined,
      per_customer_limit: undefined,
    });
    expect(legacy.max_redemptions).toBeNull();
    expect(legacy.per_customer_limit).toBeNull();
    expect(
      CouponSchema.safeParse({ ...coupon, max_redemptions: 0 }).success,
    ).toBe(false);
  });

  it('rejects a coupon that has reached its total limit', async () => {
    mockSupabase({ settings: settingsFor(coupon), totalUses: 1 });
    await expect(
      new PromotionsService().apply(lines, 'WELCOME10', userId),
    ).rejects.toThrow('usage limit');
  });

  it('rejects a coupon this customer has already used up', async () => {
    mockSupabase({
      settings: settingsFor({ ...coupon, max_redemptions: null }),
      customerUses: 1,
    });
    await expect(
      new PromotionsService().apply(lines, 'WELCOME10', userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies an available coupon and reports its limits for the order', async () => {
    mockSupabase({ settings: settingsFor(coupon) });
    const result = await new PromotionsService().apply(
      lines,
      'WELCOME10',
      userId,
    );
    expect(result.coupon_discount).toBe(20);
    expect(result.coupon_limits).toEqual({
      max_redemptions: 1,
      per_customer_limit: 1,
    });
  });

  it('lists each coupon with its redemptions and version for admins', async () => {
    mockSupabase({ settings: settingsFor(coupon), totalUses: 3 });
    const { coupons } = await new PromotionsService().managed();
    expect(coupons[0]).toMatchObject({
      code: 'WELCOME10',
      redemptions: 3,
      updated_at: '2026-10-21T10:00:00.000+00:00',
    });
  });
});

describe('saving promotions without losing another admin’s edit', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());
  it('refuses to create a coupon whose code was just created elsewhere', async () => {
    mockSupabase({ insertError: { code: '23505', message: 'duplicate key' } });
    await expect(
      new PromotionsService().saveCoupon(coupon, adminId, 'new'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an edit based on an outdated version', async () => {
    const writes = mockSupabase({
      settings: settingsFor(coupon),
      updateResult: null,
    });
    await expect(
      new PromotionsService().saveCoupon(
        coupon,
        adminId,
        '2026-10-21T09:00:00.000+00:00',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'updated_at', '2026-10-21T09:00:00.000+00:00'],
      ]),
    );
  });

  it('saves an edit based on the current version', async () => {
    mockSupabase({
      settings: settingsFor(coupon),
      updateResult: { key: 'offer_coupon_WELCOME10' },
    });
    await expect(
      new PromotionsService().saveCoupon(
        coupon,
        adminId,
        '2026-10-21T10:00:00.000+00:00',
      ),
    ).resolves.toMatchObject({ code: 'WELCOME10' });
  });
});

describe('coupon limits at order placement', () => {
  it('passes the limits to place_order and explains a race lost at the last redemption', async () => {
    const rpc = jest.fn(() =>
      Promise.resolve({
        data: null,
        error: { message: 'coupon_limit_reached' },
      }),
    );
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc,
      from: () => ({
        select: () => ({
          in: () =>
            Promise.resolve({
              data: [
                {
                  id: lines[0].product_id,
                  name: 'Helmet',
                  price: 200,
                  images: [],
                  stock: 'in-stock',
                  stock_quantity: 5,
                },
              ],
              error: null,
            }),
        }),
      }),
    } as never);
    const promotions = {
      apply: () =>
        Promise.resolve({
          original_subtotal: 200,
          subtotal: 180,
          combo_discount: 0,
          coupon_discount: 20,
          discount_total: 20,
          applied_combos: [],
          coupon_code: 'WELCOME10',
          line_totals: [180],
          priced_lines: [{ line_index: 0, quantity: 1, price: 180 }],
          coupon_limits: { max_redemptions: 1, per_customer_limit: null },
        }),
    } as unknown as PromotionsService;
    const orders = new OrdersService(
      {
        priceProducts: (rows: unknown[]) => Promise.resolve(rows),
      } as unknown as OffersService,
      promotions,
    );

    await expect(
      orders.checkout(userId, {
        shipping_address: {
          firstName: 'Test',
          lastName: 'Customer',
          email: 'test@example.com',
          phone: '01712345678',
          address: 'House 1, Road 2',
          city: 'Dhaka',
          zipCode: '1200',
        },
        payment_method: 'cod',
        delivery_zone: 'inside_dhaka',
        coupon_code: 'WELCOME10',
        items: [{ product_id: lines[0].product_id, quantity: 1 }],
      }),
    ).rejects.toThrow('usage limit');
    expect(rpc).toHaveBeenCalledWith(
      'place_order',
      expect.objectContaining({
        p_order: expect.objectContaining({
          coupon_max_redemptions: 1,
          coupon_per_customer_limit: null,
        }),
      }),
    );
  });
});
