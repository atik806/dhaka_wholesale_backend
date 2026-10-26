import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { allows, permissionsFor, legacyPermission } from './permissions.js';
import {
  AccessSchema,
  ShipmentSchema,
  ReturnCreateSchema,
  RefundApproveSchema,
} from './operations.schemas.js';
jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));
describe('staff permissions', () => {
  const rpc = jest.fn();
  beforeEach(() => {
    jest.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as never);
  });
  function guard(
    groups: string[],
    permission = 'orders.manage',
    enabled = true,
  ) {
    rpc.mockResolvedValue({ data: { enabled, groups }, error: null });
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(['admin'])
        .mockReturnValueOnce(permission),
    };
    const request = {
      user: { id: 'staff-id', role: 'customer' },
      method: 'PATCH',
      url: '/admin/orders/1/status',
    };
    const context = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return () =>
      new RolesGuard(reflector as unknown as Reflector).canActivate(context);
  }
  it('authorizes linked staff regardless of their customer profile role', async () => {
    await expect(guard(['orders'])()).resolves.toBe(true);
  });
  it('rejects disabled access on every request', async () => {
    await expect(guard(['owner'], '*', false)()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('denies support refund and inventory mutations', async () => {
    for (const permission of [
      'refunds.approve',
      'refunds.complete',
      'inventory.manage',
      '*',
    ])
      await expect(guard(['support'], permission)()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
  });
  it('fails closed when access storage fails', async () => {
    const run = guard(['owner']);
    rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('covers legacy endpoints and does not grant unknown routes to staff', () => {
    expect(legacyPermission('/api/admin/orders/1', 'GET')).toBe('orders.read');
    expect(legacyPermission('/api/admin/orders/1', 'DELETE')).toBe('*');
    expect(legacyPermission('/api/admin/staff', 'POST')).toBe('*');
    expect(
      allows(permissionsFor(['finance', 'support']), 'refunds.approve'),
    ).toBe(true);
    expect(allows(permissionsFor(['unknown']), 'orders.read')).toBe(false);
  });
});
describe('operations request validation', () => {
  it('rejects enabled accounts without a group and invented permission groups', () => {
    expect(
      AccessSchema.safeParse({ version: 0, enabled: true, groups: [] }).success,
    ).toBe(false);
    expect(
      AccessSchema.safeParse({
        version: 0,
        enabled: true,
        groups: ['superadmin'],
      }).success,
    ).toBe(false);
  });
  it('rejects executable tracking and photo URLs', () => {
    expect(
      ShipmentSchema.safeParse({
        version: 0,
        courier: 'Courier',
        tracking_number: '1',
        status: 'preparing',
        tracking_url: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(
      ReturnCreateSchema.safeParse({
        order_item_id: '00000000-0000-4000-8000-000000000001',
        quantity: 1,
        kind: 'refund',
        reason: 'Damaged',
        photos: ['file:///private'],
      }).success,
    ).toBe(false);
  });
  it('rejects zero, negative and fractional-paisa refund values', () => {
    for (const amount of [0, -1, 1.001])
      expect(RefundApproveSchema.safeParse({ amount }).success).toBe(false);
    expect(RefundApproveSchema.safeParse({ amount: 99.99 }).success).toBe(true);
  });
});
