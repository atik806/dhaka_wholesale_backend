import { z } from 'zod';

export const AddCartItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_size: z.string().optional(),
  selected_color: z.string().optional(),
});

export type AddCartItemDto = z.infer<typeof AddCartItemSchema>;

export const UpdateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  selected_size: z.string().optional(),
  selected_color: z.string().optional(),
});

export type UpdateCartItemDto = z.infer<typeof UpdateCartItemSchema>;

export const MergeCartItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_size: z.string().optional(),
  selected_color: z.string().optional(),
});

export const MergeCartSchema = z.object({
  items: z.array(MergeCartItemSchema).max(100),
});

export type MergeCartDto = z.infer<typeof MergeCartSchema>;
