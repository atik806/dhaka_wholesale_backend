import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { calculatePromotions } from '../offers/promotions-pricing.js';
import type { ComboDeal } from '../offers/promotions-pricing.js';
import type { OffersService } from '../offers/offers.service.js';
import type { PromotionsService } from '../offers/promotions.service.js';
import type { CheckoutOrderDto } from './dto/create-order.dto.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

type RpcResult = { data: unknown; error: { message: string } | null };

describe('OrdersService order placement', () => {
  const userId = '00000000-0000-4000-8000-0000000000aa';
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const key = 'checkout-key-0000000001';
  const products = [
    {
      id: a,
      name: 'Helmet',
      price: 100,
      images: ['a.jpg'],
      stock: 'in-stock',
      stock_quantity: 10,
    },
    {
      id: b,
      name: 'Gloves',
      price: 80,
      images: [],
      stock: 'in-stock',
      stock_quantity: 10,
    },
  ];
  const dto: CheckoutOrderDto = {
    idempotency_key: key,
    shipping_address: {
      firstName: 'Test',
      lastName: 'Customer',
      email: 'test@example.com',
      phone: '01712345678',
      address: 'House 1, Road 2',
      city: 'Dhaka',
      zipCode: '1200',
    },
    payment_method: 'cod',
    delivery_zone: 'inside_dhaka',
    items: [
      { product_id: a, quantity: 1 },
      { product_id: b, quantity: 1 },
    ],
  };

  let rpc: jest.Mock<Promise<RpcResult>, [string, Record<string, unknown>]>;
  let ordersInsert: jest.Mock;
  let ordersDelete: jest.Mock;
  let itemsInsert: jest.Mock;
  let cartDelete: jest.Mock;
  let cartClearError: { message: string } | null;
  let combos: ComboDeal[];
  let service: OrdersService;

  beforeEach(() => {
    cartClearError = null;
    combos = [];
    rpc = jest.fn<Promise<RpcResult>, [string, Record<string, unknown>]>(() =>
      Promise.resolve<RpcResult>({
        data: { order_id: 'order-1', replayed: false },
        error: null,
      }),
    );
    ordersInsert = jest.fn();
    ordersDelete = jest.fn();
    itemsInsert = jest.fn();
    cartDelete = jest.fn(() => Promise.resolve({ error: cartClearError }));
    const cartRows = dto.items.map((item, index) => ({
      id: `cart-${index}`,
      product_id: item.product_id,
      quantity: item.quantity,
      selected_size: null,
      selected_color: null,
      products: { ...products[index] },
    }));

    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc,
      from: (table: string) => {
        if (table === 'products')
          return {
            select: () => ({
              in: () =>
                Promise.resolve({
                  data: products.map((p) => ({ ...p })),
                  error: null,
                }),
            }),
          };
        if (table === 'cart_items')
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: cartRows, error: null }),
            }),
            delete: () => ({ eq: cartDelete }),
          };
        if (table === 'orders') {
          const query = {
            eq: () => query,
            single: () =>
              Promise.resolve({ data: { id: 'order-1' }, error: null }),
          };
          return {
            insert: ordersInsert,
            delete: () => ({ eq: ordersDelete }),
            select: () => query,
          };
        }
        if (table === 'order_items') return { insert: itemsInsert };
        if (table === 'profiles')
          return {
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        throw new Error(`Unexpected table ${table}`);
      },
    } as never);

    const offers = {
      priceProducts: (rows: unknown[]) => Promise.resolve(rows),
      prices: () => Promise.resolve(new Map<string, number>()),
    } as unknown as OffersService;
    const promotions = {
      apply: (lines) =>
        Promise.resolve(calculatePromotions(lines, combos, null, Date.now())),
    } as PromotionsService;
    service = new OrdersService(offers, promotions);
  });

  it('writes the order and its items in one place_order call with a pricing snapshot', async () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    combos = [
      {
        id: a,
        title: 'Rider kit',
        enabled: true,
        starts_at: new Date(now - 1000).toISOString(),
        ends_at: new Date(now + 1000).toISOString(),
        price: 150,
        products: [
          { product_id: a, quantity: 1 },
          { product_id: b, quantity: 1 },
        ],
      },
    ];

    const order = await service.checkout(userId, dto);

    expect(order).toEqual({ id: 'order-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('place_order');
    expect(args).toMatchObject({
      p_user_id: userId,
      p_idempotency_key: key,
      p_order: {
        original_subtotal: 180,
        combo_discount: 30,
        coupon_discount: 0,
        discount_total: 30,
        subtotal: 150,
        shipping_cost: 80,
        tax: 0,
        total: 230,
        coupon_code: null,
        payment_method: 'cod',
        delivery_zone: 'inside_dhaka',
      },
    });
    const items = args.p_items as Array<{
      price: number;
      original_price: number;
      quantity: number;
    }>;
    expect(
      items.reduce(
        (sum, item) => sum + Math.round(item.price * 100) * item.quantity,
        0,
      ),
    ).toBe(15000);
    expect(items.map((item) => item.original_price).sort()).toEqual(
      [100, 80].sort(),
    );
    expect(ordersInsert).not.toHaveBeenCalled();
    expect(itemsInsert).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('returns the original order for a retried key without clearing the cart again', async () => {
    rpc.mockResolvedValueOnce({
      data: { order_id: 'order-1', replayed: true },
      error: null,
    });

    await expect(service.checkout(userId, dto)).resolves.toEqual({
      id: 'order-1',
    });
    expect(cartDelete).not.toHaveBeenCalled();
  });

  it('rejects a reused key whose request differs', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'idempotency_key_reused' },
    });

    await expect(service.checkout(userId, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(cartDelete).not.toHaveBeenCalled();
  });

  it('hashes identical requests identically and changed requests differently', async () => {
    await service.checkout(userId, dto);
    await service.checkout(userId, { ...dto, expected_total: 260 });
    await service.checkout(userId, {
      ...dto,
      items: [{ product_id: a, quantity: 2 }, dto.items[1]],
    });

    const hashes = rpc.mock.calls.map(([, args]) => args.p_request_hash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('maps a stock failure to a conflict and never deletes an order', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: `Insufficient stock for product ${a}` },
    });

    await expect(service.checkout(userId, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(ordersDelete).not.toHaveBeenCalled();
  });

  it('surfaces an unexpected database failure as a server error', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection reset' },
    });

    await expect(service.checkout(userId, dto)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('keeps a placed cart order when clearing the cart fails', async () => {
    cartClearError = { message: 'timeout' };
    const { idempotency_key, shipping_address, payment_method, delivery_zone } =
      dto;

    await expect(
      service.create(userId, {
        idempotency_key,
        shipping_address,
        payment_method,
        delivery_zone,
      }),
    ).resolves.toEqual({ id: 'order-1' });
    expect(cartDelete).toHaveBeenCalledTimes(1);
    expect(ordersDelete).not.toHaveBeenCalled();
  });
});
