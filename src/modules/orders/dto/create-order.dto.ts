import { z } from 'zod';

const ShippingAddressSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(254),
  phone: z.string().max(30).optional(),
  address: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  zipCode: z.string().min(1).max(20),
});

// Only these payment methods are accepted. A free-form string here
// previously let a client invent a "cod" / "paid" value, which other
// parts of the code base then trusted.
export const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'card'] as const;

// Hard ceiling on line items so a single request can't blow up
// memory/query time with a 10,000-item cart.
export const MAX_CHECKOUT_ITEMS = 50;

export const CreateOrderSchema = z.object({
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
