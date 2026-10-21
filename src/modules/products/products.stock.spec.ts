import { ProductsService } from './products.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import type { CategoriesService } from '../categories/categories.service.js';
import type { CacheStore } from '../../common/cache/cache-store.js';
import type { OffersService } from '../offers/offers.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('product stock updates', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  let stored: { stock_quantity: number; stock: string };
  let update: jest.Mock;
  let service: ProductsService;

  beforeEach(() => {
    stored = { stock_quantity: 40, stock: 'in-stock' };
    update = jest.fn((value: Record<string, unknown>) => {
      const chain = {
        eq: () => chain,
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id, ...stored, ...value }, error: null }),
        }),
      };
      return chain;
    });
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: () => {
        const read = {
          eq: () => read,
          neq: () => read,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          single: () => Promise.resolve({ data: { ...stored }, error: null }),
        };
        return { select: () => read, update };
      },
    } as never);
    service = new ProductsService(
      {} as CategoriesService,
      { deleteByPrefix: jest.fn() } as unknown as CacheStore,
      {} as OffersService,
    );
  });

  it('sets the exact quantity and derives the label from it', async () => {
    await service.update(id, { stock_quantity: 4 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ stock_quantity: 4, stock: 'low-stock' }),
    );
  });

  it('never resets the quantity when an edit resends the current label', async () => {
    await service.update(id, { name: 'Helmet', stock: 'in-stock' });
    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('stock_quantity');
    expect(payload).not.toHaveProperty('stock');
  });

  it('still honours an explicit label change from an older client', async () => {
    await service.update(id, { stock: 'out-of-stock' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ stock_quantity: 0, stock: 'out-of-stock' }),
    );
  });
});

describe('product stock stats', () => {
  function serviceWith(
    counts: Record<string, number>,
    error: { message: string } | null = null,
  ) {
    const selects: [string, unknown][] = [];
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: () => ({
        select: (columns: string, options: unknown) => {
          selects.push([columns, options]);
          return {
            eq: (_column: string, stock: string) =>
              Promise.resolve({ count: counts[stock] ?? 0, error }),
          };
        },
      }),
    } as never);
    const service = new ProductsService(
      {} as CategoriesService,
      { deleteByPrefix: jest.fn() } as unknown as CacheStore,
      {} as OffersService,
    );
    return { service, selects };
  }

  it('counts each status without aggregate functions', async () => {
    const { service, selects } = serviceWith({
      'in-stock': 26,
      'low-stock': 6,
      'out-of-stock': 1,
    });
    await expect(service.getStockStats()).resolves.toEqual({
      total: 33,
      lowStock: 6,
      outOfStock: 1,
    });
    for (const [columns, options] of selects) {
      expect(columns).not.toMatch(/count\(/);
      expect(options).toEqual({ count: 'exact', head: true });
    }
  });

  it('fails loudly instead of reporting zeros', async () => {
    const { service } = serviceWith({}, { message: 'boom' });
    await expect(service.getStockStats()).rejects.toThrow();
  });
});
