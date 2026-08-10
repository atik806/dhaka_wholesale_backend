import { z } from 'zod';
import { MAX_CHECKOUT_ITEMS } from '../../orders/dto/create-order.dto.js';

const QuoteItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
});

export const CheckoutQuoteSchema = z.object({
  delivery_zone: z
    .enum(['inside_dhaka', 'outside_dhaka'])
    .default('inside_dhaka'),
  /** Client cart line items. If omitted, server cart is used. */
  items: z
    .array(QuoteItemSchema)
    .min(1)
    .max(
      MAX_CHECKOUT_ITEMS,
      `Cart exceeds limit of ${MAX_CHECKOUT_ITEMS} items`,
    )
    .optional(),
});

export type CheckoutQuoteDto = z.infer<typeof CheckoutQuoteSchema>;
