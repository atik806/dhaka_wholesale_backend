import { BadRequestException } from '@nestjs/common';
import { BdMobileSchema, CheckoutOrderSchema } from './dto/create-order.dto.js';
import { resolveVariant, variantImage } from '../../common/utils/commerce.js';
import {
  ORDER_NOTE_MAX,
  OrdersService,
  orderNote,
  withOrderNote,
} from './orders.service.js';
import { CartService } from '../cart/cart.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { calculatePromotions } from '../offers/promotions-pricing.js';
import type { OffersService } from '../offers/offers.service.js';
import type { PromotionsService } from '../offers/promotions.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

const productId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-0000000000aa';
const address = {
  firstName: 'Test',
  lastName: 'Customer',
  email: 'test@example.com',
  phone: '01712345678',
  address: 'House 1, Road 2',
  city: 'Dhaka',
  zipCode: '1200',
};
const order = {
  shipping_address: address,
  payment_method: 'cod',
  delivery_zone: 'inside_dhaka',
  items: [{ product_id: productId, quantity: 1 }],
};

describe('checkout request validation', () => {
  it.each([
    ['01712345678', '01712345678'],
    ['+8801712345678', '01712345678'],
    ['8801712345678', '01712345678'],
    ['017-1234 5678', '01712345678'],
  ])('normalises %s', (input, expected) => {
    expect(BdMobileSchema.parse(input)).toBe(expected);
  });

  it.each(['', '0171234567', '02712345678', '01212345678', 'phone'])(
    'rejects %p as a mobile number',
    (input) => {
      expect(BdMobileSchema.safeParse(input).success).toBe(false);
    },
  );

  it('requires a phone number for delivery', () => {
    const withoutPhone: Partial<typeof address> = { ...address };
    delete withoutPhone.phone;
    expect(
      CheckoutOrderSchema.safeParse({
        ...order,
        shipping_address: withoutPhone,
      }).success,
    ).toBe(false);
  });

  it.each(['bkash', 'nagad', 'card'])(
    'rejects %s until a payment provider is integrated',
    (method) => {
      expect(
        CheckoutOrderSchema.safeParse({ ...order, payment_method: method })
          .success,
      ).toBe(false);
    },
  );

  it('accepts a cash-on-delivery order', () => {
    expect(CheckoutOrderSchema.safeParse(order).success).toBe(true);
  });
});

describe('resolveVariant', () => {
  const product = {
    name: 'Helmet',
    sizes: ['M', 'L'],
    colors: [{ name: 'Black' }, { name: 'Red' }],
  };

  it('accepts a real size and colour', () => {
    expect(resolveVariant(product, 'L', 'Red')).toEqual({
      size: 'L',
      color: 'Red',
    });
  });

  it.each([
    [undefined, 'Red', 'Choose a size'],
    ['XXL', 'Red', 'not an available size'],
    ['M', undefined, 'Choose a colour'],
    ['M', 'Gold', 'not an available colour'],
  ])('rejects size %p colour %p', (size, color, message) => {
    expect(resolveVariant(product, size, color).error).toContain(message);
  });

  it('drops a selection for a product without options', () => {
    expect(resolveVariant({ name: 'Cap' }, 'XL', 'Blue')).toEqual({
      size: null,
      color: null,
    });
  });
});

describe('checkout message', () => {
  const address = { city: 'Dhaka' };

  it('keeps a trimmed message on the order address snapshot', () => {
    expect(withOrderNote(address, '  Call before delivery  ')).toEqual({
      city: 'Dhaka',
      order_note: 'Call before delivery',
    });
  });

  it('adds nothing for an empty or missing message', () => {
    expect(withOrderNote(address, '   ')).toBe(address);
    expect(withOrderNote(address, undefined)).toBe(address);
    expect(orderNote(null)).toBeNull();
  });

  it('caps a long message', () => {
    expect(orderNote('x'.repeat(ORDER_NOTE_MAX + 50))).toHaveLength(
      ORDER_NOTE_MAX,
    );
  });
});

describe('variantImage', () => {
  const product = {
    images: ['https://cdn/a.jpg', 'https://cdn/purple.jpg'],
    colors: [
      { name: 'Purple', image: 'https://cdn/purple.jpg' },
      { name: 'Red' },
      { name: 'Gone', image: 'https://cdn/deleted.jpg' },
    ],
  };

  it('uses the photo linked to the chosen colour', () => {
    expect(variantImage(product, 'Purple')).toBe('https://cdn/purple.jpg');
  });

  it('falls back to the first photo without a usable link', () => {
    expect(variantImage(product, 'Red')).toBe('https://cdn/a.jpg');
    expect(variantImage(product, 'Gone')).toBe('https://cdn/a.jpg');
    expect(variantImage(product, null)).toBe('https://cdn/a.jpg');
    expect(variantImage({ images: [] }, null)).toBeNull();
  });
});

describe('variant checks before anything is stored', () => {
  const variantProduct = {
    id: productId,
    name: 'Helmet',
    price: 100,
    images: [],
    stock: 'in-stock',
    stock_quantity: 10,
    sizes: ['M', 'L'],
    colors: [{ name: 'Black', hex: '#000' }],
  };
  let rpc: jest.Mock;
  let cartInsert: jest.Mock;
  let cartUpdate: jest.Mock;
  let existingCartRow: Record<string, unknown>;

  const offers = {
    priceProducts: (rows: unknown[]) => Promise.resolve(rows),
    prices: () => Promise.resolve(new Map<string, number>()),
  } as unknown as OffersService;
  const promotions = {
    apply: (lines) =>
      Promise.resolve(calculatePromotions(lines, [], null, Date.now())),
  } as PromotionsService;

  beforeEach(() => {
    rpc = jest.fn();
    existingCartRow = {
      id: 'cart-1',
      product_id: productId,
      selected_size: 'L',
      selected_color: 'Black',
    };
    cartInsert = jest.fn(() => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      }),
    }));
    cartUpdate = jest.fn(() => {
      const chain = {
        eq: () => chain,
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id: 'cart-1' }, error: null }),
        }),
      };
      return chain;
    });

    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc,
      from: (table: string) => {
        if (table === 'products') {
          const single = () =>
            Promise.resolve({ data: { ...variantProduct }, error: null });
          return {
            select: () => ({
              in: () =>
                Promise.resolve({ data: [variantProduct], error: null }),
              eq: () => ({ single }),
            }),
          };
        }
        if (table === 'cart_items') {
          const chain: Record<string, unknown> = {};
          for (const method of ['eq', 'is', 'order'])
            chain[method] = () => chain;
          chain.maybeSingle = () =>
            Promise.resolve({ data: existingCartRow, error: null });
          chain.then = (resolve: (value: unknown) => unknown) =>
            Promise.resolve(resolve({ data: [], error: null }));
          return {
            select: () => chain,
            insert: cartInsert,
            update: cartUpdate,
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as never);
  });

  it('rejects an invented size at checkout without placing the order', async () => {
    const service = new OrdersService(offers, promotions);
    await expect(
      service.checkout(userId, {
        ...CheckoutOrderSchema.parse(order),
        items: [
          {
            product_id: productId,
            quantity: 1,
            selected_size: 'XXXL',
            selected_color: 'Black',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an unknown colour when adding to the cart', async () => {
    const cart = new CartService(offers, promotions);
    await expect(
      cart.addItem(userId, {
        product_id: productId,
        quantity: 1,
        selected_size: 'M',
        selected_color: 'Gold',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cartInsert).not.toHaveBeenCalled();
  });

  it('keeps the chosen variant when only the quantity changes', async () => {
    const cart = new CartService(offers, promotions);
    await cart.updateItem('cart-1', userId, { quantity: 2 });
    expect(cartUpdate).toHaveBeenCalledWith({
      quantity: 2,
      selected_size: 'L',
      selected_color: 'Black',
    });
  });
});
