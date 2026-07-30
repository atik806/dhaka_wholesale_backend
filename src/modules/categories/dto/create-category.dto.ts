import { z } from 'zod';

export const CreateCategorySchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  image_url: z.string().url().optional().catch(undefined),
  parent_id: z.string().uuid().nullable().optional(),
});

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
