import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';

/**
 * httpOnly session cookie. The access + refresh tokens live here — never in
 * JavaScript-accessible storage — and are read by the AuthGuard as a
 * fallback to the Authorization header. `SameSite=Lax` blocks cross-site
 * requests from carrying the cookie; the state-changing API routes also
 * require `Content-Type: application/json`, which cross-site HTML forms
 * cannot set, so no CSRF token is needed at this threat model.
 *
 * `SameSite=Lax` requires the backend and frontend to share a registrable
 * domain (e.g. `example.com` + `api.example.com`). For genuinely cross-site
 * production deployments set `AUTH_COOKIE_SAME_SITE=None` (requires HTTPS).
 *
 * Both tokens ride in one JSON cookie. Supabase access tokens are ~1 KB JWTs
 * and refresh tokens are short opaque strings (~40 chars), so the encoded
 * cookie stays near ~1.5 KB — comfortably under the 4 KB per-cookie limit.
 * If a future auth provider issues large refresh tokens, split these into two
 * cookies before the combined value approaches 4 KB.
 */
export const AUTH_COOKIE_NAME = 'dw_session';

export interface AuthCookiePayload {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function cookieOptions(overrides: Partial<CookieOptions> = {}): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = (process.env.AUTH_COOKIE_SAME_SITE ??
    'lax') as CookieOptions['sameSite'];
  return {
    httpOnly: true,
    secure: isProd,
    sameSite,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    ...overrides,
  };
}

export function setAuthCookies(
  res: Response,
  session: { access_token: string; refresh_token: string; expires_at?: number },
) {
  const payload: AuthCookiePayload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
  res.cookie(AUTH_COOKIE_NAME, JSON.stringify(payload), cookieOptions());
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
}

export function readAuthCookies(req: Request): AuthCookiePayload | null {
  const raw = req.cookies?.[AUTH_COOKIE_NAME];
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthCookiePayload>;
    if (
      parsed &&
      typeof parsed.access_token === 'string' &&
      typeof parsed.refresh_token === 'string'
    ) {
      return parsed as AuthCookiePayload;
    }
    return null;
  } catch {
    return null;
  }
}
