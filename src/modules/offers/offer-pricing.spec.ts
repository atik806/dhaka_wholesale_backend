import {
  activeSalePrices,
  applySalePrice,
  FlashSaleSchema,
  type FlashSale,
} from './offer-pricing.js';

const id = '00000000-0000-4000-8000-000000000001';
const sale: FlashSale = {
  title: 'ঈদ Flash sale',
  enabled: true,
  starts_at: '2026-10-21T00:00:00.000Z',
  ends_at: '2026-10-22T00:00:00.000Z',
  products: [{ product_id: id, price: 80 }],
};

describe('Timed sale pricing', () => {
  it('starts at the inclusive start and ends at the exclusive end without changing stored prices', () => {
    const product = { id, price: 100, original_price: 120 };
    const start = Date.parse(sale.starts_at);
    const end = Date.parse(sale.ends_at);
    for (const [time, expected] of [
      [start - 1, 100],
      [start, 80],
      [end - 1, 80],
      [end, 100],
    ]) {
      expect(applySalePrice(product, activeSalePrices(sale, time)).price).toBe(
        expected,
      );
    }
    expect(product).toEqual({ id, price: 100, original_price: 120 });
    expect(
      applySalePrice(product, activeSalePrices(sale, start)),
    ).toMatchObject({ base_price: 100, base_original_price: 120 });
  });

  it('does not discount missing products, disabled sales, or products whose price was lowered further', () => {
    const time = Date.parse(sale.starts_at);
    expect(activeSalePrices(null, time).size).toBe(0);
    expect(activeSalePrices({ ...sale, enabled: false }, time).size).toBe(0);
    expect(
      applySalePrice({ id, price: 70 }, activeSalePrices(sale, time)).price,
    ).toBe(70);
    expect(
      applySalePrice({ id: 'other', price: 100 }, activeSalePrices(sale, time))
        .price,
    ).toBe(100);
  });

  it('preserves the original comparison price and exposes the stored base price for editing', () => {
    expect(
      applySalePrice(
        { id, price: 100, original_price: null },
        new Map([[id, 80]]),
      ),
    ).toEqual({
      id,
      price: 80,
      original_price: 100,
      base_price: 100,
      base_original_price: null,
    });
  });

  it('rejects invalid dates, duplicate or missing products, zero prices, and excessive precision', () => {
    expect(FlashSaleSchema.safeParse(sale).success).toBe(true);
    for (const change of [
      { ends_at: sale.starts_at },
      { starts_at: 'tomorrow' },
      { title: ' ' },
      { products: [] },
      { products: [...sale.products, ...sale.products] },
      { products: [{ product_id: id, price: 0 }] },
      { products: [{ product_id: id, price: 1.001 }] },
      { products: Array.from({ length: 201 }, () => sale.products[0]) },
    ])
      expect(FlashSaleSchema.safeParse({ ...sale, ...change }).success).toBe(
        false,
      );
    expect(
      FlashSaleSchema.safeParse({
        ...sale,
        products: [{ product_id: id, price: 0.01 }],
      }).success,
    ).toBe(true);
  });
});
