import { AdminService } from './admin.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

/**
 * orders has two foreign keys to profiles (user_id and paid_by), so a bare
 * `profiles(...)` embed is ambiguous and PostgREST rejects it (PGRST201).
 * Every orders query that embeds the customer must name the user_id FK.
 */
function mockSupabase() {
  const selects: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['eq', 'or', 'order', 'range', 'is']) {
      chain[method] = () => chain;
    }
    chain.select = (columns: string) => {
      if (table === 'orders') selects.push(columns);
      return chain;
    };
    chain.single = () => Promise.resolve({ data: { id: 'o1' }, error: null });
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null, count: 0 }));
    return chain;
  };
  jest.mocked(createSupabaseAdminClient).mockReturnValue({ from } as never);
  return selects;
}

const embedsCustomer = (columns: string) => columns.includes('profiles');

describe('admin order queries', () => {
  it('lists orders through the user_id relationship', async () => {
    const selects = mockSupabase();
    await new AdminService().findAllOrders({ page: 1, limit: 10 });
    const embeds = selects.filter(embedsCustomer);
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toContain('profiles!orders_user_id_fkey(');
  });

  it('loads order detail through the user_id relationship', async () => {
    const selects = mockSupabase();
    await new AdminService().getOrderDetail('o1');
    const embeds = selects.filter(embedsCustomer);
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toContain('profiles!orders_user_id_fkey(');
  });
});
