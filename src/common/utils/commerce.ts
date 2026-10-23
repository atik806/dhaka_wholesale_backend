export type DeliveryZone = 'inside_dhaka' | 'outside_dhaka';
export type StockStatus = 'in-stock' | 'low-stock' | 'out-of-stock';

export const SHIPPING_BY_ZONE: Record<DeliveryZone, number> = {
  inside_dhaka: 80,
  outside_dhaka: 120,
};

/** BD VAT not configured — tax is intentionally 0 until a site setting exists. */
export const DEFAULT_TAX_RATE = 0;

export function calculateShippingCost(deliveryZone: string): number {
  return deliveryZone === 'outside_dhaka'
    ? SHIPPING_BY_ZONE.outside_dhaka
    : SHIPPING_BY_ZONE.inside_dhaka;
}

export function calculateTax(
  subtotal: number,
  rate = DEFAULT_TAX_RATE,
): number {
  return Math.round(subtotal * rate * 100) / 100;
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function deriveStockStatus(quantity: number): StockStatus {
  if (quantity <= 0) return 'out-of-stock';
  if (quantity <= 5) return 'low-stock';
  return 'in-stock';
}

export function resolveStockQuantity(
  stockQuantity: number | undefined | null,
  stockEnum?: StockStatus | null,
): number {
  if (stockQuantity !== undefined && stockQuantity !== null) {
    return Math.max(0, Math.floor(stockQuantity));
  }
  if (stockEnum === 'out-of-stock') return 0;
  if (stockEnum === 'low-stock') return 3;
  return 25;
}

/**
 * Units a customer may order right now.
 *
 * The admin product form only edits the `stock` enum (In / Low / Out) — there is
 * no quantity field — while `stock_quantity` is seeded once and then decremented
 * by the order trigger, so it drifts toward 0 (or below) over a product's life
 * even while the shop still lists it as available. Treat the enum as the
 * availability switch and the counter as an upper bound only while it is still
 * positive; when the enum says available but the counter has drained, fall back
 * to the level the enum implies.
 */
export function availableStock(
  stockQuantity: number | undefined | null,
  stockEnum?: string | null,
): number {
  if (stockEnum === 'out-of-stock') return 0;
  const qty = Math.floor(stockQuantity ?? 0);
  if (qty > 0) return qty;
  return stockEnum === 'low-stock' ? 3 : 25;
}

export type VariantOptions = {
  name?: string | null;
  sizes?: string[] | null;
  colors?: Array<{ name?: string | null } | null> | null;
};

/**
 * Check a size/colour choice against the product's real options and return
 * the values to store. A product with sizes (or colours) requires one of
 * them; a product without options stores no selection, so a stale or
 * invented value is dropped instead of persisted. Returns an error message
 * when the choice is not valid.
 */
export function resolveVariant(
  product: VariantOptions,
  size?: string | null,
  color?: string | null,
):
  | { size: string | null; color: string | null; error?: undefined }
  | { error: string } {
  const label = product.name ? `"${product.name}"` : 'this product';
  const sizes = (product.sizes ?? []).filter(Boolean);
  const colors = (product.colors ?? [])
    .map((option) => option?.name)
    .filter((name): name is string => !!name);

  if (sizes.length > 0 && !size) return { error: `Choose a size for ${label}` };
  if (sizes.length > 0 && !sizes.includes(size!))
    return { error: `${size} is not an available size for ${label}` };
  if (colors.length > 0 && !color)
    return { error: `Choose a colour for ${label}` };
  if (colors.length > 0 && !colors.includes(color!))
    return { error: `${color} is not an available colour for ${label}` };

  return {
    size: sizes.length > 0 ? size! : null,
    color: colors.length > 0 ? color! : null,
  };
}

/**
 * The photo to store on an order line: the chosen colour's photo when the
 * product links one, otherwise the product's first photo.
 */
export function variantImage(
  product: {
    images?: string[] | null;
    colors?: Array<{
      name?: string | null;
      image?: string | null;
    } | null> | null;
  },
  color: string | null,
): string | null {
  const images = product.images ?? [];
  const linked = color
    ? product.colors?.find((option) => option?.name === color)?.image
    : null;
  return (linked && images.includes(linked) ? linked : images[0]) || null;
}
