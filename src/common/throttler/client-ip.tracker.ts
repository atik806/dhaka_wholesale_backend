import type { Request } from 'express';

/**
 * Rate-limit key: the real client IP.
 *
 * Express has no `trust proxy` set here, so `req.ip` is the address of
 * whatever connected last — on Vercel that's platform infrastructure, which
 * would put every visitor in one shared bucket (5 logins/min for the whole
 * site). Vercel overwrites `x-real-ip` / `x-forwarded-for` with the client's
 * IP, so they're trustworthy there. Anywhere else they're client-controlled
 * and spoofable, so only `req.ip` is used.
 */
export function clientIpTracker(req: Record<string, any>): Promise<string> {
  const request = req as Request;
  if (process.env.VERCEL) {
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp) return Promise.resolve(realIp);
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    if (first) return Promise.resolve(first);
  }
  return Promise.resolve(request.ip ?? 'unknown');
}
