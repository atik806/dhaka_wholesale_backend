import { z } from 'zod';

const ColorSchema = z.object({
  name: z.string(),
  hex: z.string(),
});

const MAX_IMAGES = 12;
const MAX_STRING_LIST = 50;

export const CreateProductSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().min(10).max(2000),
  price: z.number().positive().max(1_000_000),
  original_price: z
    .number()
    .positive()
    .max(1_000_000)
    .optional()
    .nullable()
    .catch(null),
  category_id: z.string().uuid(),
  images: z.array(z.string().url()).min(1).max(MAX_IMAGES),
  rating: z.number().min(0).max(5).default(0).catch(0),
  review_count: z.number().int().min(0).default(0).catch(0),
  /** Integer inventory; `stock` enum is derived from this value. */
  stock_quantity: z.number().int().min(0).max(1_000_000).optional(),
  stock: z
    .enum(['in-stock', 'low-stock', 'out-of-stock'])
    .optional()
    .catch(undefined),
  tags: z.array(z.string().max(100)).max(MAX_STRING_LIST).default([]).catch([]),
  sizes: z
    .array(z.string().max(100))
    .max(MAX_STRING_LIST)
    .default([])
    .catch([]),
  colors: z.array(ColorSchema).max(MAX_STRING_LIST).default([]).catch([]),
  is_new: z.boolean().default(false).catch(false),
  is_featured: z.boolean().default(false).catch(false),
});

export type CreateProductDto = z.infer<typeof CreateProductSchema>;
