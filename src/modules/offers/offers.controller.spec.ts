import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';
import { PromotionsController } from './promotions.controller.js';
import { PromotionsService } from './promotions.service.js';
import {
  createSupabaseClient,
  createSupabaseAdminClient,
} from '../../config/supabase.config.js';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseClient: jest.fn(),
  createSupabaseAdminClient: jest.fn(),
}));

describe('Offer API authorization and validation', () => {
  let app: INestApplication;
  const save = jest.fn(async (sale) => sale);
  const end = jest.fn(async () => ({ enabled: false }));
  const saveCombo = jest.fn(async (value) => value);
  const saveCoupon = jest.fn(async (value) => value);
  const removeCombo = jest.fn(async () => ({ deleted: true }));
  const removeCoupon = jest.fn(async () => ({ deleted: true }));
  const sale = {
    title: 'Sale',
    enabled: true,
    starts_at: '2099-01-01T00:00:00Z',
    ends_at: '2099-01-02T00:00:00Z',
    products: [
      { product_id: '00000000-0000-4000-8000-000000000001', price: 80 },
    ],
  };

  beforeAll(async () => {
    jest.mocked(createSupabaseClient).mockReturnValue({
      auth: {
        getUser: async (token: string) => ({
          data: { user: { id: token, email: 'test@example.com' } },
          error: null,
        }),
      },
    } as never);
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: async (_name: string, args: { p_user: string }) => ({
        data: {
          enabled: args.p_user === 'admin',
          groups: args.p_user === 'admin' ? ['owner'] : [],
        },
        error: null,
      }),
      from: () => ({
        select: () => ({
          eq: (_column: string, id: string) => ({
            single: async () => ({
              data: {
                role: id === 'admin' ? 'admin' : 'customer',
                name: 'Test',
              },
            }),
          }),
        }),
      }),
    } as never);
    const module = await Test.createTestingModule({
      controllers: [OffersController, PromotionsController],
      providers: [
        {
          provide: OffersService,
          useValue: { get: async () => sale, save, end },
        },
        {
          provide: PromotionsService,
          useValue: {
            activeCombos: async () => [],
            combos: async () => [],
            coupons: async () => [],
            managed: () => Promise.resolve({ combos: [], coupons: [] }),
            saveCombo,
            saveCoupon,
            removeCombo,
            removeCoupon,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    save.mockClear();
    end.mockClear();
    saveCombo.mockClear();
    saveCoupon.mockClear();
    removeCombo.mockClear();
    removeCoupon.mockClear();
  });

  it('allows public reading without exposing authentication data', async () => {
    await request(app.getHttpServer())
      .get('/offers')
      .expect(200)
      .expect({ success: true, data: sale });
  });
  it('exposes active combos publicly while keeping coupon management admin-only', async () => {
    await request(app.getHttpServer())
      .get('/offers/combos')
      .expect(200)
      .expect({ success: true, data: [] });
    await request(app.getHttpServer()).get('/offers/manage').expect(401);
    await request(app.getHttpServer())
      .get('/offers/manage')
      .set('Authorization', 'Bearer customer')
      .expect(403);
    await request(app.getHttpServer())
      .get('/offers/manage')
      .set('Authorization', 'Bearer admin')
      .expect(200)
      .expect({ success: true, data: { combos: [], coupons: [] } });
  });
  it('protects combo and coupon creation, editing, and deletion from unauthorized users', async () => {
    for (const path of ['combos', 'coupons']) {
      await request(app.getHttpServer())
        .put(`/offers/${path}`)
        .send({})
        .expect(401);
      await request(app.getHttpServer())
        .put(`/offers/${path}`)
        .set('Authorization', 'Bearer customer')
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/offers/${path}/00000000-0000-4000-8000-000000000001`)
        .expect(401);
      await request(app.getHttpServer())
        .delete(`/offers/${path}/00000000-0000-4000-8000-000000000001`)
        .set('Authorization', 'Bearer customer')
        .expect(403);
    }
    expect(saveCombo).not.toHaveBeenCalled();
    expect(saveCoupon).not.toHaveBeenCalled();
    expect(removeCombo).not.toHaveBeenCalled();
    expect(removeCoupon).not.toHaveBeenCalled();
  });
  it('validates combo quantities and coupon percentages and normalizes accepted codes', async () => {
    const coupon = {
      id: '00000000-0000-4000-8000-000000000001',
      code: ' save10 ',
      type: 'percentage',
      value: 10,
      minimum_spend: 0,
      maximum_discount: null,
      starts_at: sale.starts_at,
      ends_at: sale.ends_at,
      enabled: true,
    };
    await request(app.getHttpServer())
      .put('/offers/coupons')
      .set('Authorization', 'Bearer admin')
      .send({ ...coupon, value: 101 })
      .expect(400);
    await request(app.getHttpServer())
      .put('/offers/coupons')
      .set('Authorization', 'Bearer admin')
      .send(coupon)
      .expect(200);
    expect(saveCoupon).toHaveBeenCalledWith(
      {
        ...coupon,
        code: 'SAVE10',
        max_redemptions: null,
        per_customer_limit: null,
      },
      'admin',
      undefined,
    );
    await request(app.getHttpServer())
      .put('/offers/combos')
      .set('Authorization', 'Bearer admin')
      .send({
        id: coupon.id,
        title: 'Combo',
        price: 100,
        enabled: true,
        starts_at: sale.starts_at,
        ends_at: sale.ends_at,
        products: [{ product_id: coupon.id, quantity: 0 }],
      })
      .expect(400);
    expect(saveCombo).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated writes and end-sale requests', async () => {
    await request(app.getHttpServer()).put('/offers').send(sale).expect(401);
    await request(app.getHttpServer()).post('/offers/end').expect(401);
    expect(save).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
  it('rejects customer writes and end-sale requests', async () => {
    await request(app.getHttpServer())
      .put('/offers')
      .set('Authorization', 'Bearer customer')
      .send(sale)
      .expect(403);
    await request(app.getHttpServer())
      .post('/offers/end')
      .set('Authorization', 'Bearer customer')
      .expect(403);
    expect(save).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
  it('validates admin payloads before invoking persistence', async () => {
    await request(app.getHttpServer())
      .put('/offers')
      .set('Authorization', 'Bearer admin')
      .send({ ...sale, products: [] })
      .expect(400);
    expect(save).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .put('/offers')
      .set('Authorization', 'Bearer admin')
      .send(sale)
      .expect(200);
    expect(save).toHaveBeenCalledWith(sale, 'admin');
  });
});
