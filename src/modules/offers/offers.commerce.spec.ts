import { OffersService } from './offers.service.js';
import { CheckoutService } from '../checkout/checkout.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { CartService } from '../cart/cart.service.js';
import { CacheStore } from '../../common/cache/cache-store.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { calculateShippingCost } from '../../common/utils/commerce.js';
import { ConflictException } from '@nestjs/common';
import type { FlashSale } from './offer-pricing.js';
import { calculatePromotions } from './promotions-pricing.js';
import { PromotionsService } from './promotions.service.js';
import type { ComboDeal, Coupon } from './promotions-pricing.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('One server price across cart, quote, and order creation', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const product = {
    id,
    name: 'Helmet',
    price: 100,
    images: [],
    stock: 'in-stock',
    stock_quantity: 10,
  };
  const address = {
    firstName: 'Test',
    lastName: 'Customer',
    email: 'test@example.com',
    address: 'Test address',
    city: 'Dhaka',
    zipCode: '1200',
  };
  const dto = {
    shipping_address: address,
    payment_method: 'cod' as const,
    delivery_zone: 'inside_dhaka' as const,
  };
  const start = Date.parse('2026-10-21T00:00:00Z');
  const end = Date.parse('2026-10-22T00:00:00Z');
  let sale: FlashSale;
  let savedOrder: Record<string, unknown>;
  let savedItems: { price: number }[];
  let checkout: CheckoutService;
  let orders: OrdersService;
  let cart: CartService;
  let combos: ComboDeal[];
  let coupon: Coupon | null;

  beforeEach(() => {
    savedOrder = {};
    combos = [];
    coupon = null;
    sale = {
      title: 'Flash sale',
      enabled: true,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
      products: [{ product_id: id, price: 80 }],
    };
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      // place_order() inserts the order and its items in one transaction.
      rpc: (
        _name: string,
        args: {
          p_order: Record<string, unknown>;
          p_items: { price: number }[];
        },
      ) => {
        savedOrder = args.p_order;
        savedItems = args.p_items;
        return Promise.resolve({
          data: { order_id: 'order', replayed: false },
          error: null,
        });
      },
      from: (table: string) => {
        if (table === 'site_settings')
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { value: sale },
                  error: null,
                }),
              }),
            }),
          };
        if (table === 'products')
          return {
            select: () => ({
              in: async (_key, ids: string[]) => ({
                data: ids.map((productId) => ({ ...product, id: productId })),
                error: null,
              }),
            }),
          };
        if (table === 'cart_items') {
          const result = () => ({
            data: [
              {
                id: 'cart-row',
                product_id: id,
                quantity: 2,
                products: { ...product },
              },
            ],
            error: null,
          });
          return {
            select: () => ({
              eq: () => ({
                then: (resolve) => Promise.resolve(resolve(result())),
                order: async () => result(),
              }),
            }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === 'orders') {
          const query = {
            eq: () => query,
            single: async () => ({
              data: { id: 'order', ...savedOrder },
              error: null,
            }),
          };
          return {
            insert: (value) => {
              savedOrder = value;
              return { select: () => query };
            },
            select: () => query,
          };
        }
        if (table === 'order_items')
          return {
            insert: async (value) => {
              savedItems = value;
              return { error: null };
            },
          };
        if (table === 'profiles')
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        throw new Error(`Unexpected table ${table}`);
      },
    } as never);
    const offers = new OffersService({
      deleteByPrefix: jest.fn(),
    } as unknown as CacheStore);
    const promotions = {
      apply: async (lines) =>
        calculatePromotions(lines, combos, coupon, Date.now()),
    } as PromotionsService;
    checkout = new CheckoutService(offers, promotions);
    orders = new OrdersService(offers, promotions);
    cart = new CartService(offers, promotions);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requires a fresh confirmation when an offer changes the total after quoting', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(start);
    await expect(
      orders.checkout('customer', {
        ...dto,
        items: [{ product_id: id, quantity: 1 }],
        expected_total: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(savedOrder).toEqual({});
  });

  it('quotes and saves the same combo-plus-coupon total with exact item quantities', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(start);
    const otherId = '00000000-0000-4000-8000-000000000002';
    combos = [
      {
        id,
        title: 'Bundle',
        enabled: true,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        price: 150,
        products: [
          { product_id: id, quantity: 1 },
          { product_id: otherId, quantity: 1 },
        ],
      },
    ];
    coupon = {
      id: otherId,
      code: 'SAVE10',
      enabled: true,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
      type: 'percentage',
      value: 10,
      minimum_spend: 100,
      maximum_discount: null,
    };
    const items = [
      { product_id: id, quantity: 1 },
      { product_id: otherId, quantity: 1 },
    ];
    const quote = await checkout.quote('customer', {
      delivery_zone: 'inside_dhaka',
      items,
      coupon_code: 'SAVE10',
    });
    expect(quote).toMatchObject({
      original_subtotal: 180,
      subtotal: 135,
      combo_discount: 30,
      coupon_discount: 15,
      total: 135 + calculateShippingCost('inside_dhaka'),
    });
    await orders.checkout('customer', { ...dto, items, coupon_code: 'SAVE10' });
    expect(savedOrder.subtotal).toBe(135);
    expect(savedOrder.total).toBe(quote.total);
    expect(
      savedItems.reduce(
        (sum, item) =>
          sum +
          Math.round(item.price * 100) *
            (item as { price: number; quantity: number }).quantity,
        0,
      ),
    ).toBe(13500);
  });

  it.each([
    ['before start', start - 1, true, 100],
    ['at start', start, true, 80],
    ['during sale', start + 1_000, true, 80],
    ['at expiry', end, true, 100],
    ['ended manually', start + 1_000, false, 100],
  ])(
    '%s uses the same authoritative price everywhere',
    async (_label, now, enabled, expectedPrice) => {
      jest.spyOn(Date, 'now').mockReturnValue(now as number);
      sale.enabled = enabled as boolean;
      const price = expectedPrice as number;
      const items = [{ product_id: id, quantity: 2 }];
      const cartRows = await cart.findByUser('customer');
      expect((cartRows[0].products as unknown as { price: number }).price).toBe(
        price,
      );
      for (const quoteItems of [undefined, items]) {
        const quote = await checkout.quote('customer', {
          delivery_zone: 'inside_dhaka',
          items: quoteItems,
        });
        expect(quote.items[0].price).toBe(price);
        expect(quote.subtotal).toBe(price * 2);
        expect(quote.total).toBe(
          price * 2 + calculateShippingCost('inside_dhaka'),
        );
      }
      await orders.checkout('customer', { ...dto, items });
      expect(savedOrder.subtotal).toBe(price * 2);
      expect(savedItems[0].price).toBe(price);
      await orders.create('customer', dto);
      expect(savedOrder.subtotal).toBe(price * 2);
      expect(savedItems[0].price).toBe(price);
      expect(product.price).toBe(100);
    },
  );
});
