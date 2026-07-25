import { z } from 'zod';

export const AddWishlistSchema = z.object({
  product_id: z.string().uuid(),
});

export type AddWishlistDto = z.infer<typeof AddWishlistSchema>;

export const MergeWishlistSchema = z.object({
  product_ids: z.array(z.string().uuid()).max(200),
});

export type MergeWishlistDto = z.infer<typeof MergeWishlistSchema>;
