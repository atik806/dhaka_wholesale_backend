import { z } from 'zod';

export const QueryProductsSchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(100).optional(),
  // Multi-category selection: each entry is a category slug. When present,
  // takes precedence over `category` (a single slug).
  categories: z.array(z.string().trim().max(100).min(1)).max(20).optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z
    .enum(['newest', 'price-asc', 'price-desc', 'rating', 'popular'])
    .optional()
    .default('popular'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(12),
  ids: z.array(z.string().uuid()).max(200).optional(),
});

export type QueryProductsDto = z.infer<typeof QueryProductsSchema>;
