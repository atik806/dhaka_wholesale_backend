import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

const actorId = '00000000-0000-4000-8000-0000000000ad';
const otherId = '00000000-0000-4000-8000-0000000000bb';

/**
 * profiles/orders stand-in. Head counts answer "how many admins" and "how
 * many orders"; single() returns the target profile; writes are recorded.
 */
function mockSupabase(options: {
  target?: { id: string; role: string } | null;
  adminCount?: number;
  orderCount?: number;
}) {
  const writes: string[] = [];
  const deleteAuthUser = jest.fn(() => Promise.resolve({ error: null }));
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    let head = false;
    for (const method of ['eq', 'neq']) chain[method] = () => chain;
    chain.select = (_columns: string, opts?: { head?: boolean }) => {
      head = !!opts?.head;
      return chain;
    };
    chain.update = () => {
      writes.push(`update:${table}`);
      return chain;
    };
    chain.delete = () => {
      writes.push(`delete:${table}`);
      return chain;
    };
    chain.single = () =>
      Promise.resolve({ data: options.target ?? null, error: null });
    chain.maybeSingle = chain.single;
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        resolve(
          head
            ? {
                count:
                  table === 'orders'
                    ? (options.orderCount ?? 0)
                    : (options.adminCount ?? 2),
                error: null,
              }
            : { error: null },
        ),
      );
    return chain;
  };
  jest.mocked(createSupabaseAdminClient).mockReturnValue({
    from,
    auth: { admin: { deleteUser: deleteAuthUser } },
  } as never);
  return { writes, deleteAuthUser };
}

describe('admin user safety', () => {
  it('does not let an admin remove their own admin access', async () => {
    const { writes } = mockSupabase({ target: { id: actorId, role: 'admin' } });
    await expect(
      new AdminService().updateUserRole(actorId, 'customer', actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);
  });

  it('keeps at least one admin', async () => {
    const { writes } = mockSupabase({
      target: { id: otherId, role: 'admin' },
      adminCount: 1,
    });
    await expect(
      new AdminService().updateUserRole(otherId, 'customer', actorId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });

  it('demotes another admin while others remain', async () => {
    const { writes } = mockSupabase({
      target: { id: otherId, role: 'admin' },
      adminCount: 2,
    });
    await new AdminService().updateUserRole(otherId, 'customer', actorId);
    expect(writes).toEqual(['update:profiles']);
  });

  it('does not let an admin delete their own account', async () => {
    const { deleteAuthUser } = mockSupabase({
      target: { id: actorId, role: 'admin' },
    });
    await expect(
      new AdminService().deleteUser(actorId, actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it('refuses to delete a customer whose orders would be erased with them', async () => {
    const { deleteAuthUser } = mockSupabase({
      target: { id: otherId, role: 'customer' },
      orderCount: 3,
    });
    await expect(
      new AdminService().deleteUser(otherId, actorId),
    ).rejects.toThrow('3 orders');
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it('deletes a customer without orders', async () => {
    const { deleteAuthUser } = mockSupabase({
      target: { id: otherId, role: 'customer' },
      orderCount: 0,
    });
    await new AdminService().deleteUser(otherId, actorId);
    expect(deleteAuthUser).toHaveBeenCalledWith(otherId);
  });
});
