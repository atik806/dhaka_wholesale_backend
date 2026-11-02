import { InternalServerErrorException } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { guestEmailFor, isGuestEmail } from './guest-customer.js';
import { RegisterSchema } from '../auth/dto/register.dto.js';
import { CheckoutOrderSchema } from './dto/create-order.dto.js';
import type { CheckoutOrderDto } from './dto/create-order.dto.js';
import type { OffersService } from '../offers/offers.service.js';
import type { PromotionsService } from '../offers/promotions.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('guest checkout', () => {
  const dto = {
    shipping_address: {
      firstName: 'Rina',
      lastName: 'Akter',
      phone: '01712345678',
      address: 'House 1, Road 2, Mirpur',
      city: 'Dhaka',
    },
    payment_method: 'cod',
    delivery_zone: 'inside_dhaka',
    items: [
      { product_id: '00000000-0000-4000-8000-000000000001', quantity: 1 },
    ],
  } as CheckoutOrderDto;

  let profileLookups: Array<{ id: string } | null>;
  let guestMeta: unknown;
  let createUser: jest.Mock;
  let upsert: jest.Mock;
  let service: OrdersService;
  let checkoutSpy: jest.SpyInstance;

  beforeEach(() => {
    profileLookups = [null];
    guestMeta = { guest: true };
    createUser = jest.fn(() =>
      Promise.resolve({ data: { user: { id: 'new-guest' } }, error: null }),
    );
    upsert = jest.fn(() => Promise.resolve({ error: null }));
    const client = {
      from: jest.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: profileLookups.shift() ?? null }),
          }),
        }),
        upsert,
      })),
      auth: {
        admin: {
          createUser,
          deleteUser: jest.fn(),
          getUserById: jest.fn(() =>
            Promise.resolve({
              data: { user: { user_metadata: guestMeta } },
              error: null,
            }),
          ),
        },
      },
    };
    (createSupabaseAdminClient as jest.Mock).mockReturnValue(client);
    service = new OrdersService({} as OffersService, {} as PromotionsService);
    checkoutSpy = jest
      .spyOn(service, 'checkout')
      .mockImplementation((userId) =>
        Promise.resolve({ id: 'order-1', user_id: userId } as never),
      );
  });

  it('creates a hidden customer for a new phone number', async () => {
    const order = await service.guestCheckout(dto);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: guestEmailFor('01712345678'),
        user_metadata: expect.objectContaining({ guest: true }),
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-guest', phone: '01712345678' }),
      { onConflict: 'id' },
    );
    expect(order).toMatchObject({ user_id: 'new-guest', guest: true });
  });

  it('reuses the same customer for a returning phone number', async () => {
    profileLookups = [{ id: 'existing-guest' }];
    const order = await service.guestCheckout(dto);
    expect(createUser).not.toHaveBeenCalled();
    expect(order).toMatchObject({ user_id: 'existing-guest' });
  });

  it('refuses to file an order under a non-guest account', async () => {
    profileLookups = [{ id: 'real-user' }];
    guestMeta = {};
    await expect(service.guestCheckout(dto)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(checkoutSpy).not.toHaveBeenCalled();
  });

  it('accepts an order without email or postcode', () => {
    expect(CheckoutOrderSchema.safeParse(dto).success).toBe(true);
    expect(
      CheckoutOrderSchema.safeParse({
        ...dto,
        shipping_address: { ...dto.shipping_address, email: '' },
      }).success,
    ).toBe(true);
  });

  it('does not let anyone register a guest address', () => {
    expect(isGuestEmail(guestEmailFor('01712345678'))).toBe(true);
    const result = RegisterSchema.safeParse({
      name: 'Someone',
      email: guestEmailFor('01712345678'),
      password: 'Str0ng!pass',
    });
    expect(result.success).toBe(false);
  });
});
