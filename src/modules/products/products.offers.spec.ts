import { ProductsService } from './products.service.js';
import { OffersService } from '../offers/offers.service.js';
import { CategoriesService } from '../categories/categories.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { QueryProductsSchema } from './dto/query-products.dto.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Sale catalog filters and pagination', () => {
  it('accepts a single selected product ID as well as repeated query parameters', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(QueryProductsSchema.parse({ ids: id }).ids).toEqual([id]);
    expect(QueryProductsSchema.parse({ ids: [id] }).ids).toEqual([id]);
    expect(QueryProductsSchema.safeParse({ ids: 'invalid' }).success).toBe(
      false,
    );
  });
  const rows = Array.from({ length: 75 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    price: 100 + index,
    original_price: null,
    rating: index % 5,
    review_count: index % 4,
    created_at: new Date(index * 1000).toISOString(),
  }));
  let prices: Map<string, number>;
  let service: ProductsService;

  beforeEach(() => {
    prices = new Map(
      rows
        .filter((_, index) => index % 3 === 0)
        .map((row, index) => [row.id, 10 + index]),
    );
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: () => {
        let selected = rows.slice();
        let range = [0, rows.length - 1];
        const order: [string, boolean][] = [];
        const query = {
          select: () => query,
          in: (key: string, values: unknown[]) => {
            selected = selected.filter((row) => values.includes(row[key]));
            return query;
          },
          not: (_key: string, _operator: string, value: string) => {
            const ids = value.slice(1, -1).split(',');
            selected = selected.filter((row) => !ids.includes(row.id));
            return query;
          },
          gte: (key: string, value: number) => {
            selected = selected.filter((row) => row[key] >= value);
            return query;
          },
          lte: (key: string, value: number) => {
            selected = selected.filter((row) => row[key] <= value);
            return query;
          },
          order: (key: string, options: { ascending: boolean }) => {
            order.push([key, options.ascending]);
            return query;
          },
          range: (start: number, end: number) => {
            range = [start, end];
            return query;
          },
          then: (resolve: (value: unknown) => unknown) => {
            selected.sort((a, b) => {
              for (const [key, asc] of order) {
                const comparison =
                  a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
                if (comparison) return asc ? comparison : -comparison;
              }
              return 0;
            });
            return Promise.resolve(
              resolve({
                data: selected.slice(range[0], range[1] + 1),
                count: selected.length,
                error: null,
              }),
            );
          },
        };
        return query;
      },
    } as never);
    service = new ProductsService(
      {} as CategoriesService,
      {} as CacheStore,
      { prices: async () => prices } as OffersService,
    );
  });

  it.each(['price-asc', 'price-desc', 'rating', 'newest', 'popular'] as const)(
    'keeps %s ordering and totals correct across page boundaries',
    async (sort) => {
      const all = rows.map((row) => ({
        ...row,
        price: prices.get(row.id) ?? row.price,
      }));
      const key = sort.startsWith('price')
        ? 'price'
        : sort === 'newest'
          ? 'created_at'
          : sort === 'rating'
            ? 'rating'
            : 'review_count';
      all.sort((a, b) => {
        const comparison = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
        return (
          (sort === 'price-asc' ? comparison : -comparison) ||
          a.id.localeCompare(b.id)
        );
      });
      const output: unknown[] = [];
      for (let page = 1; page <= 7; page++) {
        const result = await service.findAll({ sort, page, limit: 12 });
        expect(result.meta.total).toBe(rows.length);
        output.push(
          ...result.data.map((product) => ({
            id: product.id,
            price: product.price,
          })),
        );
      }
      expect(output).toEqual(
        all.map((product) => ({ id: product.id, price: product.price })),
      );
    },
  );

  it('filters by discounted price and returns only selected sale products', async () => {
    const result = await service.findAll({
      onSale: true,
      priceMin: 10,
      priceMax: 18,
      sort: 'price-asc',
      page: 1,
      limit: 12,
    });
    expect(result.meta.total).toBe(9);
    expect(result.data.map((product) => product.price)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    prices.clear();
    const ended = await service.findAll({
      onSale: true,
      sort: 'popular',
      page: 1,
      limit: 12,
    });
    expect(ended.data).toEqual([]);
    expect(ended.meta.total).toBe(0);
  });
});
