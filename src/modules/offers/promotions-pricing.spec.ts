import { BadRequestException } from '@nestjs/common';
import {
  calculatePromotions,
  ComboSchema,
  CouponSchema,
  type ComboDeal,
  type Coupon,
} from './promotions-pricing.js';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const c = '00000000-0000-4000-8000-000000000003';
const start = '2026-10-21T00:00:00Z';
const end = '2026-10-22T00:00:00Z';
const now = Date.parse(start);
const combo: ComboDeal = {
  id: a,
  title: 'Helmet + gloves',
  enabled: true,
  starts_at: start,
  ends_at: end,
  price: 120,
  products: [
    { product_id: a, quantity: 1 },
    { product_id: b, quantity: 1 },
  ],
};
const coupon: Coupon = {
  id: b,
  code: 'SAVE10',
  enabled: true,
  starts_at: start,
  ends_at: end,
  type: 'percentage',
  value: 10,
  minimum_spend: 0,
  maximum_discount: null,
};
const lines = [
  { product_id: a, price: 100, quantity: 1 },
  { product_id: b, price: 50, quantity: 1 },
];

describe('Combos and coupons pricing', () => {
  it('requires every bundle product and quantity before applying a deal', () => {
    expect(calculatePromotions(lines, [combo], null, now)).toMatchObject({
      subtotal: 120,
      combo_discount: 30,
    });
    expect(
      calculatePromotions(lines.slice(0, 1), [combo], null, now).combo_discount,
    ).toBe(0);
    expect(
      calculatePromotions(
        lines,
        [
          {
            ...combo,
            products: [
              { product_id: a, quantity: 2 },
              { product_id: b, quantity: 1 },
            ],
          },
        ],
        null,
        now,
      ).combo_discount,
    ).toBe(0);
  });
  it('applies repeated sets, aggregates variant lines, and retains extra items', () => {
    const result = calculatePromotions(
      [
        { product_id: a, price: 100, quantity: 1 },
        { product_id: a, price: 100, quantity: 2 },
        { product_id: b, price: 50, quantity: 2 },
        { product_id: c, price: 20, quantity: 1 },
      ],
      [combo],
      null,
      now,
    );
    expect(result.subtotal).toBe(360);
    expect(result.applied_combos[0].quantity).toBe(2);
    expect(result.combo_discount).toBe(60);
    expect(result.line_totals[3]).toBe(20);
  });
  it('does not double-count products across overlapping combos', () => {
    const alternative = { ...combo, id: c, price: 100 };
    const result = calculatePromotions(lines, [combo, alternative], null, now);
    expect(result.subtotal).toBe(100);
    expect(result.applied_combos).toHaveLength(1);
    expect(result.applied_combos[0].id).toBe(c);
  });
  it('keeps lower flash-sale prices and respects exact start/end boundaries', () => {
    const cheapLines = lines.map((line) => ({ ...line, price: 40 }));
    expect(calculatePromotions(cheapLines, [combo], null, now).subtotal).toBe(
      80,
    );
    expect(
      calculatePromotions(lines, [combo], null, now - 1).combo_discount,
    ).toBe(0);
    expect(
      calculatePromotions(lines, [combo], null, Date.parse(end)).combo_discount,
    ).toBe(0);
    expect(
      calculatePromotions(lines, [{ ...combo, enabled: false }], null, now)
        .combo_discount,
    ).toBe(0);
  });
  it('applies percentage coupons after combos and honors maximum discounts', () => {
    expect(calculatePromotions(lines, [combo], coupon, now)).toMatchObject({
      original_subtotal: 150,
      subtotal: 108,
      combo_discount: 30,
      coupon_discount: 12,
      discount_total: 42,
      coupon_code: 'SAVE10',
    });
    expect(
      calculatePromotions(
        lines,
        [combo],
        { ...coupon, maximum_discount: 5 },
        now,
      ).subtotal,
    ).toBe(115);
  });
  it('caps fixed coupons at the remaining merchandise amount and permits free merchandise', () => {
    const result = calculatePromotions(
      lines,
      [combo],
      { ...coupon, type: 'fixed', value: 1000 },
      now,
    );
    expect(result.subtotal).toBe(0);
    expect(result.discount_total).toBe(150);
    expect(result.priced_lines.every((line) => line.price >= 0)).toBe(true);
  });
  it('rejects inactive, future, expired, and below-minimum coupons', () => {
    for (const invalid of [
      { ...coupon, enabled: false },
      { ...coupon, starts_at: end },
      { ...coupon, ends_at: start },
      { ...coupon, minimum_spend: 121 },
    ]) {
      expect(() => calculatePromotions(lines, [combo], invalid, now)).toThrow(
        BadRequestException,
      );
    }
    expect(
      calculatePromotions(
        lines,
        [combo],
        { ...coupon, minimum_spend: 120 },
        now,
      ).subtotal,
    ).toBe(108);
  });
  it('persists whole-cent unit prices whose quantity totals exactly match the discounted subtotal', () => {
    const result = calculatePromotions(
      [
        { product_id: a, price: 0.1, quantity: 3 },
        { product_id: b, price: 0.2, quantity: 7 },
      ],
      [],
      { ...coupon, type: 'fixed', value: 0.03 },
      now,
    );
    expect(result.subtotal).toBe(1.67);
    expect(
      result.priced_lines.reduce(
        (sum, line) => sum + Math.round(line.price * 100) * line.quantity,
        0,
      ),
    ).toBe(167);
    expect(
      result.priced_lines
        .filter((line) => line.line_index === 0)
        .reduce((sum, line) => sum + line.quantity, 0),
    ).toBe(3);
    expect(lines[0].price).toBe(100);
  });
  it('normalizes codes and validates combo/coupon form constraints', () => {
    expect(CouponSchema.parse({ ...coupon, code: ' save10 ' }).code).toBe(
      'SAVE10',
    );
    expect(CouponSchema.safeParse({ ...coupon, value: 101 }).success).toBe(
      false,
    );
    expect(CouponSchema.safeParse({ ...coupon, value: 0 }).success).toBe(false);
    expect(
      CouponSchema.safeParse({ ...coupon, minimum_spend: -1 }).success,
    ).toBe(false);
    expect(CouponSchema.safeParse({ ...coupon, ends_at: start }).success).toBe(
      false,
    );
    expect(
      ComboSchema.safeParse({
        ...combo,
        products: [combo.products[0], combo.products[0]],
      }).success,
    ).toBe(false);
    expect(
      ComboSchema.safeParse({
        ...combo,
        products: [{ product_id: a, quantity: 0 }, combo.products[1]],
      }).success,
    ).toBe(false);
  });
});
