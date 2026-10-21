import { z } from 'zod';

export const FlashSaleSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    products: z
      .array(
        z
          .object({
            product_id: z.string().uuid(),
            price: z.number().positive().max(1_000_000).multipleOf(0.01),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((sale, ctx) => {
    if (Date.parse(sale.ends_at) <= Date.parse(sale.starts_at)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ends_at'],
        message: 'End must be after start',
      });
    }
    if (
      new Set(sale.products.map((item) => item.product_id)).size !==
      sale.products.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['products'],
        message: 'Products must be unique',
      });
    }
  });

export type FlashSale = z.infer<typeof FlashSaleSchema>;
export type PricedProduct = {
  id: string;
  price: number;
  original_price?: number | null;
};

export function activeSalePrices(
  sale: FlashSale | null,
  now: number,
): Map<string, number> {
  if (
    !sale?.enabled ||
    now < Date.parse(sale.starts_at) ||
    now >= Date.parse(sale.ends_at)
  ) {
    return new Map();
  }
  return new Map(sale.products.map((item) => [item.product_id, item.price]));
}

/** Preserve stored prices; only lower them while a flash sale is live. */
export function applySalePrice<T extends PricedProduct>(
  product: T,
  prices: Map<string, number>,
): T & { base_price: number; base_original_price: number | null } {
  const price = prices.get(product.id);
  if (price === undefined || price >= Number(product.price)) {
    return {
      ...product,
      base_price: product.price,
      base_original_price: product.original_price ?? null,
    };
  }
  return {
    ...product,
    base_price: product.price,
    base_original_price: product.original_price ?? null,
    original_price: Math.max(
      Number(product.original_price) || 0,
      Number(product.price),
    ),
    price,
  };
}
