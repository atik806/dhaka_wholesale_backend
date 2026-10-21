import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const money = z.number().positive().max(1_000_000).multipleOf(0.01);
const windowFields = {
  id: z.string().uuid(),
  enabled: z.boolean(),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
};
function validWindow(
  value: { starts_at: string; ends_at: string },
  ctx: z.RefinementCtx,
) {
  if (Date.parse(value.ends_at) <= Date.parse(value.starts_at)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ends_at'],
      message: 'End must be after start',
    });
  }
}
export const ComboSchema = z
  .object({
    ...windowFields,
    title: z.string().trim().min(1).max(120),
    price: money,
    products: z
      .array(
        z
          .object({
            product_id: z.string().uuid(),
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    validWindow(value, ctx);
    if (
      new Set(value.products.map((item) => item.product_id)).size !==
      value.products.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['products'],
        message: 'Products must be unique',
      });
    }
  });
export const CouponSchema = z
  .object({
    ...windowFields,
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(
        /^[A-Z0-9_-]{3,40}$/,
        'Use 3–40 letters, numbers, underscores or hyphens',
      ),
    type: z.enum(['percentage', 'fixed']),
    value: money,
    minimum_spend: z.number().min(0).max(1_000_000).multipleOf(0.01).default(0),
    maximum_discount: money.nullable().default(null),
    // Usage limits; null means unlimited (and is what coupons saved before
    // limits existed parse to). Enforced by place_order() under a lock.
    max_redemptions: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .nullable()
      .default(null),
    per_customer_limit: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    validWindow(value, ctx);
    if (value.type === 'percentage' && value.value > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Percentage cannot exceed 100',
      });
    }
  });
export const CouponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,40}$/)
  .optional();
export type ComboDeal = z.infer<typeof ComboSchema>;
export type Coupon = z.infer<typeof CouponSchema>;
export type PromotionLine = {
  product_id: string;
  price: number;
  quantity: number;
};
export function promotionIsLive(
  value: { enabled: boolean; starts_at: string; ends_at: string },
  now: number,
) {
  return (
    value.enabled &&
    Date.parse(value.starts_at) <= now &&
    now < Date.parse(value.ends_at)
  );
}
const cents = (value: number) => Math.round(value * 100);

/** Allocate whole cents, retaining every cent and never over-discounting a line. */
function allocate(amount: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !amount) return weights.map(() => 0);
  amount = Math.min(amount, sum);
  const result = weights.map((weight) => Math.floor((amount * weight) / sum));
  let remainder = amount - result.reduce((a, b) => a + b, 0);
  const indices = weights
    .map((weight, index) => ({ index, remainder: (amount * weight) % sum }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of indices) {
    if (!remainder) break;
    if (result[item.index] < weights[item.index]) {
      result[item.index]++;
      remainder--;
    }
  }
  return result;
}

export function calculatePromotions(
  lines: PromotionLine[],
  combos: ComboDeal[],
  coupon: Coupon | null,
  now: number,
) {
  const totals = lines.map((line) => cents(line.price) * line.quantity);
  const original = totals.reduce((a, b) => a + b, 0);
  const quantities = new Map<string, number>();
  const prices = new Map<string, number>();
  for (const line of lines) {
    quantities.set(
      line.product_id,
      (quantities.get(line.product_id) ?? 0) + line.quantity,
    );
    prices.set(line.product_id, cents(line.price));
  }
  const discounts = new Map<string, number>();
  const candidates = combos
    .filter((combo) => promotionIsLive(combo, now))
    .map((combo) => ({
      combo,
      saving: combo.products.every((item) => prices.has(item.product_id))
        ? combo.products.reduce(
            (sum, item) => sum + prices.get(item.product_id)! * item.quantity,
            0,
          ) - cents(combo.price)
        : 0,
    }))
    .filter((item) => item.saving > 0)
    .sort(
      (a, b) => b.saving - a.saving || a.combo.id.localeCompare(b.combo.id),
    );
  const appliedCombos: {
    id: string;
    title: string;
    quantity: number;
    discount: number;
  }[] = [];
  for (const { combo, saving } of candidates) {
    const sets = Math.min(
      ...combo.products.map((item) =>
        Math.floor((quantities.get(item.product_id) ?? 0) / item.quantity),
      ),
    );
    if (!sets) continue;
    const weights = combo.products.map(
      (item) => prices.get(item.product_id)! * item.quantity * sets,
    );
    const portions = allocate(saving * sets, weights);
    combo.products.forEach((item, index) => {
      quantities.set(
        item.product_id,
        quantities.get(item.product_id)! - item.quantity * sets,
      );
      discounts.set(
        item.product_id,
        (discounts.get(item.product_id) ?? 0) + portions[index],
      );
    });
    appliedCombos.push({
      id: combo.id,
      title: combo.title,
      quantity: sets,
      discount: (saving * sets) / 100,
    });
  }
  for (const [productId, discount] of discounts) {
    const indices = lines
      .map((line, index) => (line.product_id === productId ? index : -1))
      .filter((index) => index >= 0);
    const portions = allocate(
      discount,
      indices.map((index) => totals[index]),
    );
    indices.forEach((index, position) => {
      totals[index] -= portions[position];
    });
  }
  const afterCombo = totals.reduce((a, b) => a + b, 0);
  let couponDiscount = 0;
  if (coupon) {
    if (!promotionIsLive(coupon, now))
      throw new BadRequestException(
        'This coupon is inactive or outside its valid dates',
      );
    if (afterCombo < cents(coupon.minimum_spend))
      throw new BadRequestException(
        `This coupon requires a minimum spend of ৳${coupon.minimum_spend} after combo discounts`,
      );
    couponDiscount =
      coupon.type === 'fixed'
        ? cents(coupon.value)
        : Math.round((afterCombo * coupon.value) / 100);
    couponDiscount = Math.min(
      afterCombo,
      couponDiscount,
      coupon.maximum_discount === null
        ? Infinity
        : cents(coupon.maximum_discount),
    );
    const portions = allocate(couponDiscount, totals);
    totals.forEach((_, index) => {
      totals[index] -= portions[index];
    });
  }
  // Split a line only when needed to preserve exact cents at integer quantities.
  const pricedLines: { line_index: number; quantity: number; price: number }[] =
    [];
  lines.forEach((line, index) => {
    const unit = Math.floor(totals[index] / line.quantity);
    const higherUnits = totals[index] % line.quantity;
    if (higherUnits < line.quantity)
      pricedLines.push({
        line_index: index,
        quantity: line.quantity - higherUnits,
        price: unit / 100,
      });
    if (higherUnits)
      pricedLines.push({
        line_index: index,
        quantity: higherUnits,
        price: (unit + 1) / 100,
      });
  });
  return {
    original_subtotal: original / 100,
    subtotal: (afterCombo - couponDiscount) / 100,
    combo_discount: (original - afterCombo) / 100,
    coupon_discount: couponDiscount / 100,
    discount_total: (original - afterCombo + couponDiscount) / 100,
    applied_combos: appliedCombos,
    coupon_code: coupon?.code ?? null,
    line_totals: totals.map((total) => total / 100),
    priced_lines: pricedLines,
  };
}
