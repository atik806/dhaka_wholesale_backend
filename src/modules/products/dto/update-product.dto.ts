import { z } from 'zod';

const ColorSchema = z.object({
  name: z.string(),
  hex: z.string(),
});

export const UpdateProductSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  price: z.number().positive().optional(),
  original_price: z.number().positive().optional().nullable(),
  category_id: z.string().uuid().optional(),
  images: z.array(z.string().url()).min(1).optional(),
  rating: z.number().min(0).max(5).optional(),
  review_count: z.number().int().min(0).optional(),
  stock: z.enum(['in-stock', 'low-stock', 'out-of-stock']).optional(),
  tags: z.array(z.string()).optional(),
  sizes: z.array(z.string()).optional(),
  colors: z.array(ColorSchema).optional(),
  is_new: z.boolean().optional(),
  is_featured: z.boolean().optional(),
});

export type UpdateProductDto = z.infer<typeof UpdateProductSchema>;
