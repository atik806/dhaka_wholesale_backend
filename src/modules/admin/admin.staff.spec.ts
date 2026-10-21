import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Admin staff management', () => {
  const from = jest.fn();
  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createSupabaseAdminClient).mockReturnValue({ from } as never);
    service = new AdminService();
  });

  it('lists staff with search, filters, and pagination metadata', async () => {
    const range = jest.fn().mockResolvedValue({
      data: [{ id: 'staff-1', name: 'Nusrat Jahan', status: 'active' }],
      error: null,
      count: 1,
    });
    const order = jest.fn(() => ({ range }));
    const eqDepartment = jest.fn(() => ({ order }));
    const eqStatus = jest.fn(() => ({ eq: eqDepartment }));
    const or = jest.fn(() => ({ eq: eqStatus }));
    const select = jest.fn(() => ({ or }));
    from.mockReturnValue({ select });

    await expect(
      service.findAllStaff({
        page: 2,
        limit: 10,
        search: 'Nusrat,()',
        status: 'active',
        department: 'Sales',
      }),
    ).resolves.toEqual({
      data: [{ id: 'staff-1', name: 'Nusrat Jahan', status: 'active' }],
      meta: { total: 1, page: 2, limit: 10, totalPages: 1 },
    });
    expect(from).toHaveBeenCalledWith('staff_members');
    expect(or).toHaveBeenCalledWith(
      'name.ilike.%Nusrat%,email.ilike.%Nusrat%,job_title.ilike.%Nusrat%,department.ilike.%Nusrat%',
    );
    expect(eqStatus).toHaveBeenCalledWith('status', 'active');
    expect(eqDepartment).toHaveBeenCalledWith('department', 'Sales');
    expect(range).toHaveBeenCalledWith(10, 19);
  });

  it('creates a staff member and reports duplicate emails clearly', async () => {
    const single = jest
      .fn()
      .mockResolvedValueOnce({
        data: { id: 'staff-1', email: 'staff@example.com' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });
    const select = jest.fn(() => ({ single }));
    const insert = jest.fn(() => ({ select }));
    from.mockReturnValue({ insert });

    const dto = {
      name: 'Nusrat Jahan',
      email: 'staff@example.com',
      phone: '+8801712345678',
      job_title: 'Sales Manager',
      department: 'Sales',
      status: 'active' as const,
      joined_at: '2026-10-21',
      avatar_url: null,
    };

    await expect(service.createStaff(dto)).resolves.toEqual(
      expect.objectContaining({ id: 'staff-1' }),
    );
    await expect(service.createStaff(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns not found for a missing staff member update', async () => {
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'No rows' },
    });
    const select = jest.fn(() => ({ single }));
    const eq = jest.fn(() => ({ select }));
    const update = jest.fn(() => ({ eq }));
    from.mockReturnValue({ update });

    await expect(
      service.updateStaff('staff-1', { status: 'inactive' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('surfaces database failures when deleting staff', async () => {
    const eq = jest.fn().mockResolvedValue({
      error: { code: '500', message: 'Database unavailable' },
      count: null,
    });
    const remove = jest.fn(() => ({ eq }));
    from.mockReturnValue({ delete: remove });

    await expect(service.deleteStaff('staff-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('reports update database failures as server errors instead of not found', async () => {
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { code: '500', message: 'Database unavailable' },
    });
    from.mockReturnValue({
      update: () => ({ eq: () => ({ select: () => ({ single }) }) }),
    });
    await expect(
      service.updateStaff('staff-1', { status: 'active' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('returns an empty directory with zero pages', async () => {
    from.mockReturnValue({
      select: () => ({
        order: () => ({
          range: jest
            .fn()
            .mockResolvedValue({ data: [], count: 0, error: null }),
        }),
      }),
    });
    await expect(service.findAllStaff({})).resolves.toEqual({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    });
  });
});
