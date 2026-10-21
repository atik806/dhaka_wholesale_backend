import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminService } from '../admin/admin.service.js';
import { OrdersService } from './orders.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import type { OffersService } from '../offers/offers.service.js';
import type { PromotionsService } from '../offers/promotions.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

type Result = { data: unknown; error: { message: string } | null };
type Call = { method: string; args: unknown[] };

/** One query chain on a table: records every builder call, resolves `result`. */
function query(result: Result) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'eq', 'delete']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.single = () => Promise.resolve(result);
  builder.maybeSingle = () => Promise.resolve(result);
  return { builder, calls };
}

const filters = (calls: Call[]) =>
  calls.filter((c) => c.method === 'eq').map((c) => c.args);
const updates = (calls: Call[]) =>
  calls.filter((c) => c.method === 'update').map((c) => c.args[0]);

describe('atomic order transitions', () => {
  const orderId = '00000000-0000-4000-8000-000000000010';
  const userId = '00000000-0000-4000-8000-0000000000aa';
  const adminId = '00000000-0000-4000-8000-0000000000ad';
  let chains: ReturnType<typeof query>[];

  function useResults(...results: Result[]) {
    chains = results.map(query);
    let next = 0;
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      from: () => chains[next++].builder,
    } as never);
  }

  const orders = () =>
    new OrdersService({} as OffersService, {} as PromotionsService);

  it('cancels only while the order is still pending, in one conditional update', async () => {
    useResults(
      { data: { id: orderId, status: 'pending' }, error: null },
      { data: { id: orderId, status: 'cancelled' }, error: null },
    );

    await expect(orders().cancelOrder(orderId, userId)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(updates(chains[1].calls)).toEqual([{ status: 'cancelled' }]);
    expect(filters(chains[1].calls)).toEqual(
      expect.arrayContaining([
        ['id', orderId],
        ['user_id', userId],
        ['status', 'pending'],
      ]),
    );
  });

  it('reports a conflict when an admin ships the order before the cancel lands', async () => {
    useResults(
      { data: { id: orderId, status: 'pending' }, error: null },
      { data: null, error: null },
    );

    await expect(orders().cancelOrder(orderId, userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects an admin status change the state machine forbids, without writing', async () => {
    useResults({ data: { id: orderId, status: 'shipped' }, error: null });

    await expect(
      new AdminService().updateOrderStatus(orderId, 'cancelled'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chains).toHaveLength(1);
  });

  it('updates status only if it is unchanged since it was read', async () => {
    useResults(
      { data: { id: orderId, status: 'confirmed' }, error: null },
      { data: { id: orderId, status: 'shipped' }, error: null },
    );

    await new AdminService().updateOrderStatus(orderId, 'shipped');
    expect(filters(chains[1].calls)).toEqual(
      expect.arrayContaining([
        ['id', orderId],
        ['status', 'confirmed'],
      ]),
    );
  });

  it('reports a conflict when another change won the race', async () => {
    useResults(
      { data: { id: orderId, status: 'pending' }, error: null },
      { data: null, error: null },
    );

    await expect(
      new AdminService().updateOrderStatus(orderId, 'cancelled'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('treats setting the current status again as a no-op', async () => {
    useResults({ data: { id: orderId, status: 'shipped' }, error: null });

    await expect(
      new AdminService().updateOrderStatus(orderId, 'shipped'),
    ).resolves.toMatchObject({ status: 'shipped' });
    expect(chains).toHaveLength(1);
  });

  it('will not mark cash collected before the order has shipped', async () => {
    useResults({
      data: { id: orderId, status: 'confirmed', payment_status: 'pending' },
      error: null,
    });

    await expect(
      new AdminService().updatePaymentStatus(orderId, 'paid', adminId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chains).toHaveLength(1);
  });

  it('records who collected the cash and when', async () => {
    useResults(
      {
        data: { id: orderId, status: 'delivered', payment_status: 'pending' },
        error: null,
      },
      { data: { id: orderId, payment_status: 'paid' }, error: null },
    );

    await new AdminService().updatePaymentStatus(orderId, 'paid', adminId);
    const [update] = updates(chains[1].calls) as Array<Record<string, unknown>>;
    expect(update).toMatchObject({ payment_status: 'paid', paid_by: adminId });
    expect(typeof update.paid_at).toBe('string');
    expect(filters(chains[1].calls)).toEqual(
      expect.arrayContaining([
        ['id', orderId],
        ['payment_status', 'pending'],
        ['status', 'delivered'],
      ]),
    );
  });
});
