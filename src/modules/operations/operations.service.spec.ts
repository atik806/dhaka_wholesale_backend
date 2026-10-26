import { OperationsService } from './operations.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));
describe('operations API responses', () => {
  it('normalizes a one-to-one PostgREST refund into the API array contract', async () => {
    const refund = { id: 'refund', amount: 100, status: 'approved' };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'range'])
      builder[method] = () => builder;
    builder.then = (resolve: (result: unknown) => unknown) =>
      Promise.resolve(
        resolve({
          data: [
            { id: 'return', refunds: refund },
            { id: 'other', refunds: null },
          ],
          error: null,
          count: 2,
        }),
      );
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: async () => ({
        data: { enabled: true, groups: ['finance'] },
        error: null,
      }),
      from: () => builder,
    } as never);
    const result = await new OperationsService().list(
      'returns',
      { page: 1, limit: 25 },
      'finance',
    );
    expect(result.data).toEqual([
      { id: 'return', refunds: [refund] },
      { id: 'other', refunds: [] },
    ]);
  });
  it('does not query inventory when support asks for its private cost data', async () => {
    const from = jest.fn();
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: async () => ({
        data: { enabled: true, groups: ['support'] },
        error: null,
      }),
      from,
    } as never);
    await expect(
      new OperationsService().list(
        'inventory',
        { page: 1, limit: 25 },
        'support',
      ),
    ).rejects.toThrow('Insufficient permissions');
    expect(from).not.toHaveBeenCalled();
  });
});
