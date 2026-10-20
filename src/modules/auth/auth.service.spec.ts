import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  createSupabaseAdminClient,
  createSupabaseAuthClient,
} from '../../config/supabase.config';
import { AuthService } from './auth.service';
import { ChangeAdminPasswordSchema } from './dto/change-admin-password.dto';

jest.mock('../../config/supabase.config', () => ({
  createSupabaseClient: jest.fn(),
  createSupabaseAuthClient: jest.fn(),
  createSupabaseAdminClient: jest.fn(),
}));

describe('AuthService admin password management', () => {
  const signInWithPassword = jest.fn();
  const createUser = jest.fn();
  const updateUserById = jest.fn();
  const signOut = jest.fn();
  const upsert = jest.fn();
  const from = jest.fn(() => ({ upsert }));

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'Bootstrap1!';

    jest.mocked(createSupabaseAuthClient).mockReturnValue({
      auth: { signInWithPassword },
    } as never);
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      auth: { admin: { createUser, updateUserById, signOut } },
      from,
    } as never);
    upsert.mockResolvedValue({ error: null });
    service = new AuthService();
  });

  afterAll(() => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  it('logs in with the current Supabase password after rotation', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'admin-id' },
        session: {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_at: 123,
        },
      },
      error: null,
    });

    const result = await service.adminLogin({
      email: 'ADMIN@example.com',
      password: 'Rotated2!',
    });

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'Rotated2!',
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-id', role: 'admin' }),
      { onConflict: 'id' },
    );
    expect(result.user.role).toBe('admin');
  });

  it('does not bootstrap an account from an arbitrary failed password', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });

    await expect(
      service.adminLogin({
        email: 'admin@example.com',
        password: 'Wrong2!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('bootstraps a missing admin only with the deployment password', async () => {
    signInWithPassword
      .mockResolvedValueOnce({
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      })
      .mockResolvedValueOnce({
        data: {
          user: { id: 'new-admin-id' },
          session: {
            access_token: 'access',
            refresh_token: 'refresh',
            expires_at: 123,
          },
        },
        error: null,
      });
    createUser.mockResolvedValue({
      data: { user: { id: 'new-admin-id' } },
      error: null,
    });

    const result = await service.adminLogin({
      email: 'admin@example.com',
      password: 'Bootstrap1!',
    });

    expect(createUser).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'Bootstrap1!',
      email_confirm: true,
    });
    expect(result.user.id).toBe('new-admin-id');
  });

  it('verifies the current password, updates it, and revokes sessions', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'admin-id' },
        session: { access_token: 'verified-access' },
      },
      error: null,
    });
    updateUserById.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });

    await expect(
      service.changeAdminPassword('admin-id', 'admin@example.com', {
        current_password: 'Current1!',
        new_password: 'Replacement2!',
      }),
    ).resolves.toEqual({
      message: 'Password updated. Sign in again with your new password.',
    });

    expect(updateUserById).toHaveBeenCalledWith('admin-id', {
      password: 'Replacement2!',
    });
    expect(signOut).toHaveBeenCalledWith('verified-access');
  });

  it('rejects an incorrect current password without changing anything', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });

    await expect(
      service.changeAdminPassword('admin-id', 'admin@example.com', {
        current_password: 'Wrong1!',
        new_password: 'Replacement2!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('requires a strong new password different from the current one', () => {
    expect(
      ChangeAdminPasswordSchema.safeParse({
        current_password: 'SamePass1!',
        new_password: 'SamePass1!',
      }).success,
    ).toBe(false);
    expect(
      ChangeAdminPasswordSchema.safeParse({
        current_password: 'Current1!',
        new_password: 'weak',
      }).success,
    ).toBe(false);
    expect(
      ChangeAdminPasswordSchema.safeParse({
        current_password: 'Current1!',
        new_password: 'StrongPass2!',
      }).success,
    ).toBe(true);
  });
});
