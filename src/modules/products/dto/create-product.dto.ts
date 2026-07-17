import { z } from 'zod';

const ColorSchema = z.object({
  name: z.string(),
  hex: z.string(),
});

export const CreateProductSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().min(10).max(2000),
  price: z.number().positive(),
  original_price: z.number().positive().optional().nullable().catch(null),
  category_id: z.string().uuid(),
  images: z.array(z.string().url()).min(1),
  rating: z.number().min(0).max(5).default(0).catch(0),
  review_count: z.number().int().min(0).default(0).catch(0),
  stock: z
    .enum(['in-stock', 'low-stock', 'out-of-stock'])
    .default('in-stock')
    .catch('in-stock'),
  tags: z.array(z.string()).default([]).catch([]),
  sizes: z.array(z.string()).default([]).catch([]),
  colors: z.array(ColorSchema).default([]).catch([]),
  is_new: z.boolean().default(false).catch(false),
  is_featured: z.boolean().default(false).catch(false),
});

export type CreateProductDto = z.infer<typeof CreateProductSchema>;
