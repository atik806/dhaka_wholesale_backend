import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';

const DEFAULT_CORS_ORIGIN = 'https://dhakawholesale.com';

/**
 * Blocks cross-origin cookie-setting requests on routes that import a
 * session supplied by the request body (the OAuth `POST /auth/sync-session`
 * handoff). A malicious page can send an authenticated-looking POST with
 * `Content-Type: application/json` and `credentials: include` even though the
 * browser would not attach our SameSite cookie — without this check an attacker
 * could plant attacker-owned tokens in the victim's cookie jar (session
 * fixation).
 *
 * - No `Origin`/`Referer` header  -> non-browser client (curl, mobile) -> pass.
 * - Header present                -> must reduce to an origin in the same
 *   allowlist used by CORS in main.ts, so this can never be stricter than the
 *   network boundary but is enforced server-side on the cookie-setting route.
 */
@Injectable()
export class CookieOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const origin =
      request.headers.origin ?? request.headers.referer ?? undefined;
    if (!origin) {
      return true;
    }

    const allowlist = (process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (
      process.env.NODE_ENV !== 'production' &&
      !allowlist.includes('http://localhost:3000')
    ) {
      allowlist.push('http://localhost:3000');
    }

    // `Origin` is already an origin; `Referer` is a full URL — normalize both.
    const candidate = this.toOrigin(origin);
    if (!candidate || !allowlist.includes(candidate)) {
      throw new ForbiddenException('Cross-origin session import denied');
    }
    return true;
  }

  private toOrigin(value: string): string | null {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }
}
