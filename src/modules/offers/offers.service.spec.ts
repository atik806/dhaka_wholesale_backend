import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { OffersService } from './offers.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import type { FlashSale } from './offer-pricing.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Saving a flash sale', () => {
  const sale: FlashSale = {
    title: 'Flash sale',
    enabled: true,
    starts_at: '2099-01-01T00:00:00Z',
    ends_at: '2099-01-02T00:00:00Z',
    products: [
      { product_id: '00000000-0000-4000-8000-000000000001', price: 80 },
    ],
  };
  const verify = jest.fn();
  const upsert = jest.fn();
  const update = jest.fn();
  const read = jest.fn();
  const invalidate = jest.fn();
  let service: OffersService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: jest.fn((table) =>
        table === 'products'
          ? { select: () => ({ in: verify }) }
          : {
              select: () => ({ eq: () => ({ maybeSingle: read }) }),
              upsert,
              update,
            },
      ),
    } as never);
    verify.mockResolvedValue({
      data: [{ id: sale.products[0].product_id, name: 'Helmet', price: 100 }],
      error: null,
    });
    upsert.mockResolvedValue({ error: null });
    update.mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    service = new OffersService({
      deleteByPrefix: invalidate,
    } as unknown as CacheStore);
  });

  it('publishes one complete setting without updating product rows', async () => {
    await expect(service.save(sale, 'admin')).resolves.toEqual(sale);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flash_sale',
        value: sale,
        updated_by: 'admin',
      }),
      { onConflict: 'key' },
    );
    expect(invalidate).toHaveBeenCalledWith('GET:/products');
  });

  it('rejects missing products or prices equal to or above stored prices before publishing', async () => {
    for (const price of [80, 70]) {
      verify.mockResolvedValue({
        data: [{ id: sale.products[0].product_id, name: 'Helmet', price }],
        error: null,
      });
      await expect(service.save(sale, 'admin')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    verify.mockResolvedValue({ data: [], error: null });
    await expect(service.save(sale, 'admin')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reports persistence errors and leaves the published offer intact', async () => {
    upsert.mockResolvedValue({ error: { message: 'Database unavailable' } });
    await expect(service.save(sale, 'admin')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ends the saved sale while retaining its product selection and dates', async () => {
    read.mockResolvedValue({ data: { value: sale }, error: null });
    await service.end('admin');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ value: { ...sale, enabled: false } }),
    );
  });

  it('ending an unconfigured sale is harmless', async () => {
    read.mockResolvedValue({ data: null, error: null });
    await expect(service.end('admin')).resolves.toEqual({ enabled: false });
    expect(update).not.toHaveBeenCalled();
  });
});
