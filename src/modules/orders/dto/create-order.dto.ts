import { z } from 'zod';
import { CouponCodeSchema } from '../../offers/promotions-pricing.js';

/**
 * Bangladeshi mobile number, normalised to the 11-digit local form
 * (01XXXXXXXXX). Accepts +880 / 880 prefixes, spaces and dashes. Cash on
 * delivery depends on a confirmation call, so a valid number is required.
 */
export const BdMobileSchema = z
  .string()
  .transform((value) => {
    const digits = value.replace(/[\s()-]/g, '').replace(/^\+/, '');
    return digits.startsWith('880') ? digits.slice(2) : digits;
  })
  .refine((value) => /^01[3-9]\d{8}$/.test(value), {
    message: 'Enter a valid Bangladeshi mobile number, e.g. 01712345678',
  });

const ShippingAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: BdMobileSchema,
  address: z.string().trim().min(5).max(500),
  city: z.string().trim().min(2).max(100),
  zipCode: z.string().trim().min(1).max(20),
});

// Only payment methods the shop can actually settle are accepted. COD is the
// only one today; add bKash/Nagad/card here only together with a real
// provider integration (verified callbacks, reconciliation, refunds).
export const PAYMENT_METHODS = ['cod'] as const;

// Hard ceiling on line items so a single request can't blow up
// memory/query time with a 10,000-item cart.
export const MAX_CHECKOUT_ITEMS = 50;

// One key per checkout attempt, reused by the client on retry so a timeout
// or double submit returns the original order instead of placing another.
// Optional until every client sends it.
const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,100}$/)
  .optional();

export const CreateOrderSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  expected_total: z.number().min(0).max(100_000_000_000).optional(),
  coupon_code: CouponCodeSchema,
  shipping_address: ShippingAddressSchema,
  payment_method: z.enum(PAYMENT_METHODS),
  delivery_zone: z
    .enum(['inside_dhaka', 'outside_dhaka'])
    .default('inside_dhaka'),
  notes: z.string().max(1000).optional(),
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

const CheckoutItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
  selected_size: z.string().max(100).nullable().optional(),
  selected_color: z.string().max(100).nullable().optional(),
});

export const CheckoutOrderSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  expected_total: z.number().min(0).max(100_000_000_000).optional(),
  coupon_code: CouponCodeSchema,
  shipping_address: ShippingAddressSchema,
  payment_method: z.enum(PAYMENT_METHODS),
  delivery_zone: z
    .enum(['inside_dhaka', 'outside_dhaka'])
    .default('inside_dhaka'),
  items: z
    .array(CheckoutItemSchema)
    .min(1, 'Cart is empty')
    .max(
      MAX_CHECKOUT_ITEMS,
      `Cart exceeds limit of ${MAX_CHECKOUT_ITEMS} items`,
    ),
  notes: z.string().max(1000).optional(),
});

export type CheckoutOrderDto = z.infer<typeof CheckoutOrderSchema>;
