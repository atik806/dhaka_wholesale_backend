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

@Injectable()
export class HttpCacheInterceptor {
  private readonly logger = new Logger(HttpCacheInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cacheStore: CacheStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
      response.setHeader('Cache-Control', this.buildCacheControl(ttl, ttl));
      response.setHeader('Vary', 'Accept-Encoding, Authorization');
      return of(cached);
    }

    return next.handle().pipe(
      tap((data) => {
        this.cacheStore.set(cacheKey, data, ttl);

        response.setHeader('X-Cache', 'MISS');
        response.setHeader('Cache-Control', this.buildCacheControl(ttl, ttl));
        response.setHeader('Vary', 'Accept-Encoding, Authorization');
      }),
    );
  }

  private buildCacheControl(maxAge: number, ttl: number): string {
    const swr = Math.max(ttl * 5, 300);
    return `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`;
  }

  private generateKey(context: ExecutionContext): string {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    // Scope cached responses by user id. A user-specific cached body
    // (e.g. an authenticated view) must never leak to another user via
    // a shared key that ignores identity.
    const userScope = user?.sub ?? user?.id ?? 'anon';
    return `${request.method}:${request.url}:user:${userScope}`;
  }
}
