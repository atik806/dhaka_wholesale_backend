import { z } from 'zod';

const ShippingAddressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  address: z.string().min(1),
  city: z.string().min(1),
  zipCode: z.string().min(1),
});

export const CreateOrderSchema = z.object({
  shipping_address: ShippingAddressSchema,
  payment_method: z.string().min(1),
  delivery_zone: z.enum(['inside_dhaka', 'outside_dhaka']).default('inside_dhaka'),
  notes: z.string().optional(),
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;

const CheckoutItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
  selected_size: z.string().nullable().optional(),
  selected_color: z.string().nullable().optional(),
});

export const CheckoutOrderSchema = z.object({
  shipping_address: ShippingAddressSchema,
  payment_method: z.string().min(1),
  delivery_zone: z.enum(['inside_dhaka', 'outside_dhaka']).default('inside_dhaka'),
  items: z.array(CheckoutItemSchema).min(1, 'Cart is empty'),
  notes: z.string().optional(),
});

export type CheckoutOrderDto = z.infer<typeof CheckoutOrderSchema>;
