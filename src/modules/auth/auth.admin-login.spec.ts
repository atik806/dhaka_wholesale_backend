import { UnauthorizedException } from '@nestjs/common';
import {
  createSupabaseAdminClient,
  createSupabaseAuthClient,
} from '../../config/supabase.config.js';
import { AuthService } from './auth.service.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseClient: jest.fn(),
  createSupabaseAuthClient: jest.fn(),
  createSupabaseAdminClient: jest.fn(),
}));

describe('Admin login authorization', () => {
  const signInWithPassword = jest.fn();
  const createUser = jest.fn();
  const signOut = jest.fn();
  const single = jest.fn();
  const eq = jest.fn(() => ({ single }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  let service: AuthService;
  let previousEmail: string | undefined;
  let previousPassword: string | undefined;

  beforeEach(() => {
    jest.resetAllMocks();
    previousEmail = process.env.ADMIN_EMAIL;
    previousPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'Bootstrap1!';
    eq.mockReturnValue({ single });
    select.mockReturnValue({ eq });
    from.mockReturnValue({ select });
    signOut.mockResolvedValue({ error: null });
    jest
      .mocked(createSupabaseAuthClient)
      .mockReturnValue({ auth: { signInWithPassword } } as never);
    jest.mocked(createSupabaseAdminClient).mockReturnValue({
      auth: { admin: { createUser, signOut } },
      from,
    } as never);
    service = new AuthService();
  });

  afterEach(() => {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  });

  it('never bootstraps a different email even with the deployment password', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid credentials' },
    });
    await expect(
      service.adminLogin({
        email: 'customer@example.com',
        password: 'Bootstrap1!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('denies and revokes a session when the authoritative profile is unavailable', async () => {
    signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'user-id' },
        session: { access_token: 'access-token' },
      },
      error: null,
    });
    single.mockResolvedValue({
      data: null,
      error: { message: 'Profile unavailable' },
    });
    await expect(
      service.adminLogin({
        email: 'manager@example.com',
        password: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(signOut).toHaveBeenCalledWith('access-token');
    expect(createUser).not.toHaveBeenCalled();
  });
});
