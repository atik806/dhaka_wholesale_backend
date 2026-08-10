import { z } from 'zod';

// The refresh token is optional because the httpOnly `dw_session` cookie is
// now the primary source; the body is accepted only for API clients that
// still pass it explicitly.
export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>;
