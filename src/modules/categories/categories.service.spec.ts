import { InternalServerErrorException } from '@nestjs/common';
import { CategoriesService } from './categories.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Category product counts', () => {
  const order = jest.fn();
  const select = jest.fn(() => ({ order }));
  const from = jest.fn(() => ({ select }));
  let service: CategoriesService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createSupabaseAdminClient).mockReturnValue({ from } as never);
    service = new CategoriesService({} as CacheStore);
  });

  it('replaces stale counters with direct product counts and keeps empty children', async () => {
    order.mockResolvedValue({
      data: [
        {
          id: 'parent',
          parent_id: null,
          product_count: 3,
          products: [{ count: 0 }],
        },
        {
          id: 'child',
          parent_id: 'parent',
          product_count: 99,
          products: [{ count: 4 }],
        },
        {
          id: 'empty',
          parent_id: 'parent',
          product_count: 8,
          products: [{ count: 0 }],
        },
      ],
      error: null,
    });
    const tree = await service.findTree();
    expect(select).toHaveBeenCalledWith('*, products(count)');
    expect(tree[0].product_count).toBe(0);
    expect(tree[0].children).toEqual([
      expect.objectContaining({ id: 'child', product_count: 4 }),
      expect.objectContaining({ id: 'empty', product_count: 0 }),
    ]);
    expect(tree[0]).not.toHaveProperty('products');
  });

  it('returns an empty category list when no categories exist', async () => {
    order.mockResolvedValue({ data: [], error: null });
    await expect(service.findAll()).resolves.toEqual([]);
  });

  it('reports database failures instead of returning misleading zero counts', async () => {
    order.mockResolvedValue({
      data: null,
      error: { message: 'Database unavailable' },
    });
    await expect(service.findAll()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
