import { z } from 'zod';

const ColorSchema = z.object({
  name: z.string().max(100),
  hex: z.string().max(20),
});

const MAX_IMAGES = 12;
const MAX_STRING_LIST = 50;

export const UpdateProductSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  price: z.number().positive().max(1_000_000).optional(),
  original_price: z.number().positive().max(1_000_000).optional().nullable(),
  category_id: z.string().uuid().optional(),
  images: z.array(z.string().url()).min(1).max(MAX_IMAGES).optional(),
  rating: z.number().min(0).max(5).optional(),
  review_count: z.number().int().min(0).optional(),
  /** Integer inventory; `stock` enum is derived from this value when set. */
  stock_quantity: z.number().int().min(0).max(1_000_000).optional(),
  stock: z.enum(['in-stock', 'low-stock', 'out-of-stock']).optional(),
  tags: z.array(z.string().max(100)).max(MAX_STRING_LIST).optional().catch([]),
  sizes: z.array(z.string().max(100)).max(MAX_STRING_LIST).optional().catch([]),
  colors: z.array(ColorSchema).max(MAX_STRING_LIST).optional().catch([]),
  is_new: z.boolean().optional(),
  is_featured: z.boolean().optional(),
});

export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;
