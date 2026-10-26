import { createSupabaseAdminClient } from '../../config/supabase.config.js';
jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));
import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';

describe('Staff admin API', () => {
  const id = 'f13b12ee-9c59-442d-97a0-3ab77d88e8b8';
  const validBody = {
    name: '  Nusrat Jahan  ',
    email: 'NUSRAT@example.com',
    job_title: 'Sales Manager',
    department: 'Sales',
    joined_at: '2026-10-21',
  };
  const service = {
    findAllStaff: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
    createStaff: jest.fn().mockImplementation((body) => ({ id, ...body })),
    updateStaff: jest.fn().mockImplementation((_id, body) => ({ id, ...body })),
    deleteStaff: jest.fn().mockResolvedValue({ message: 'Removed' }),
  };
  let app: INestApplication;

  beforeAll(async () => {
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: async (_name: string, args: { p_user: string }) => ({
        data: {
          enabled: args.p_user === id,
          groups: args.p_user === id ? ['owner'] : [],
        },
        error: null,
      }),
    } as never);
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: service }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers['x-test-role'];
          if (!role) throw new UnauthorizedException();
          req.user = {
            id: role === 'admin' ? id : '00000000-0000-4000-8000-000000000001',
            role,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('normalizes new staff details and defaults the initial status', async () => {
    await request(app.getHttpServer())
      .post('/admin/staff')
      .set('x-test-role', 'admin')
      .send(validBody)
      .expect(201);
    expect(service.createStaff).toHaveBeenCalledWith({
      ...validBody,
      name: 'Nusrat Jahan',
      email: 'nusrat@example.com',
      status: 'active',
    });
  });

  it('does not change staff status when editing another field', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/staff/${id}`)
      .set('x-test-role', 'admin')
      .send({ job_title: 'Team Lead' })
      .expect(200);
    expect(service.updateStaff).toHaveBeenCalledWith(id, {
      job_title: 'Team Lead',
    });
  });

  it.each([
    { name: '   ' },
    { name: 'a'.repeat(101) },
    { email: 'invalid-email' },
    { status: 'admin' },
    { joined_at: '2026-02-30' },
    { avatar_url: 'javascript:alert(1)' },
  ])('rejects invalid staff details: %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/admin/staff')
      .set('x-test-role', 'admin')
      .send({ ...validBody, ...invalid })
      .expect(400);
    expect(service.createStaff).not.toHaveBeenCalled();
  });

  it('rejects an empty patch and invalid staff ID', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/staff/${id}`)
      .set('x-test-role', 'admin')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .delete('/admin/staff/invalid-id')
      .set('x-test-role', 'admin')
      .expect(400);
  });

  it('validates pagination limits and status filters', async () => {
    for (const query of ['limit=101', 'page=0', 'status=admin']) {
      await request(app.getHttpServer())
        .get(`/admin/staff?${query}`)
        .set('x-test-role', 'admin')
        .expect(400);
    }
    expect(service.findAllStaff).not.toHaveBeenCalled();
  });

  it('uses pagination defaults on an unfiltered directory request', async () => {
    await request(app.getHttpServer())
      .get('/admin/staff')
      .set('x-test-role', 'admin')
      .expect(200);
    expect(service.findAllStaff).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      search: '',
    });
  });

  it.each(['get', 'post', 'patch', 'delete'] as const)(
    'requires an authenticated administrator for %s',
    async (method) => {
      const url = `/admin/staff${method === 'patch' || method === 'delete' ? `/${id}` : ''}`;
      await request(app.getHttpServer())
        [method](url)
        .send(validBody)
        .expect(401);
      await request(app.getHttpServer())
        [method](url)
        .set('x-test-role', 'customer')
        .send(validBody)
        .expect(403);
      for (const handler of Object.values(service))
        expect(handler).not.toHaveBeenCalled();
    },
  );
});
