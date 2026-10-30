import {
  Injectable,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, tap } from 'rxjs';
import { Response } from 'express';
import { CacheStore } from '../cache/cache-store.js';

export const CACHE_TTL_KEY = 'cache_ttl';

/**
 * Public, non-user endpoints the storefront polls or loads on every home page
 * view (flash sale, combos, promo banner, featured products, recent reviews).
 * Letting the Vercel CDN hold them for 15s means one function run per 15s in
 * total instead of one per open tab per poll. Prices are still re-computed
 * server-side by cart quote and place_order, so a 15s-stale banner or
 * featured list can't change what a customer pays.
 */
export const PUBLIC_POLL_CACHE_CONTROL =
  'public, max-age=0, s-maxage=15, stale-while-revalidate=45';

// GET /offers, /offers/combos and /products/featured carry
// PUBLIC_POLL_CACHE_CONTROL; every other price-bearing route below stays
// no-store.
const PUBLIC_POLL_ROUTE =
  /^\/(?:api\/)?(?:offers(?:\/combos)?|products\/featured)(?:\?|$)/;

@Injectable()
export class HttpCacheInterceptor {
  private readonly logger = new Logger(HttpCacheInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cacheStore: CacheStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Price-bearing responses must reflect sale boundaries and edits immediately.
    const priceRequest = context.switchToHttp().getRequest();
    if (
      priceRequest.method === 'GET' &&
      PUBLIC_POLL_ROUTE.test(String(priceRequest.url))
    ) {
      return next.handle();
    }
    if (
      /^\/(?:api\/)?(?:products|offers|cart|checkout|wishlist)(?:\/|\?|$)/.test(
        String(priceRequest.url),
      )
    ) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Cache-Control', 'no-store');
      return next.handle();
    }
    const ttl = this.reflector.get<number>(CACHE_TTL_KEY, context.getHandler());
    if (ttl === undefined) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown }>();
    const response = context.switchToHttp().getResponse<Response>();

    // Authenticated responses must never be shared. A `public` header with
    // s-maxage would let a shared cache (CDN/proxy) serve one user's body to
    // another, so authed responses are marked `private, no-store` and bypass
    // the cache store entirely (no-store means the response must not be
    // stored anywhere, not even our in-memory store).
    if (request.user) {
      response.setHeader('Cache-Control', 'private, no-store');
      return next.handle();
    }

    const cacheKey = this.generateKey(context);
    const cached = this.cacheStore.get(cacheKey);

    if (cached !== undefined) {
      response.setHeader('X-Cache', 'HIT');
      response.setHeader('Cache-Control', this.buildCacheControl(ttl));
      response.setHeader('Vary', 'Accept-Encoding, Authorization');
      return of(cached);
    }

    return next.handle().pipe(
      tap((data) => {
        this.cacheStore.set(cacheKey, data, ttl);

        response.setHeader('X-Cache', 'MISS');
        response.setHeader('Cache-Control', this.buildCacheControl(ttl));
        response.setHeader('Vary', 'Accept-Encoding, Authorization');
      }),
    );
  }

  // Browsers always revalidate (max-age=0): they can't be told when data
  // changes, so a browser max-age kept showing stale counts after edits. The
  // CDN holds the response for the TTL and may serve it stale for one more
  // TTL while it refetches.
  private buildCacheControl(ttl: number): string {
    return `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl}`;
  }

  private generateKey(context: ExecutionContext): string {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    // Scope cached responses by user id. A user-specific cached body
    // (e.g. an authenticated view) must never leak to another user via
    // a shared key that ignores identity.
    const userScope = user?.sub ?? user?.id ?? 'anon';
    // Strip the global `/api` prefix so keys read as `GET:/products?...`. The
    // service-side cache busters call `deleteByPrefix('GET:/products')` /
    // `'GET:/categories'`; leaving the prefix in made every invalidation a
    // silent no-op and served stale listings for the full TTL.
    const url = String(request.url).replace(/^\/api(?=\/|\?|$)/, '');
    return `${request.method}:${url}:user:${userScope}`;
  }
}
