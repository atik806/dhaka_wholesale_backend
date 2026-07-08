import { z } from 'zod';

export const QueryProductsSchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z
    .enum(['newest', 'price-asc', 'price-desc', 'rating', 'popular'])
    .optional()
    .default('popular'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(12),
});

export type QueryProductsDto = z.infer<typeof QueryProductsSchema>;
