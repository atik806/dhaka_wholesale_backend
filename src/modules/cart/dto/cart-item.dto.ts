import { z } from 'zod';

const SIZE_COLOR_MAX = 100;

export const AddCartItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_size: z.string().max(SIZE_COLOR_MAX).optional(),
  selected_color: z.string().max(SIZE_COLOR_MAX).optional(),
});

export type AddCartItemDto = z.infer<typeof AddCartItemSchema>;

export const UpdateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  selected_size: z.string().max(SIZE_COLOR_MAX).optional(),
  selected_color: z.string().max(SIZE_COLOR_MAX).optional(),
});

export type UpdateCartItemDto = z.infer<typeof UpdateCartItemSchema>;

export const MergeCartItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_size: z.string().max(SIZE_COLOR_MAX).optional(),
  selected_color: z.string().max(SIZE_COLOR_MAX).optional(),
});

export const MergeCartSchema = z.object({
  items: z.array(MergeCartItemSchema).max(100),
});

export type MergeCartDto = z.infer<typeof MergeCartSchema>;
