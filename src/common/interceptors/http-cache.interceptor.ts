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

    const cacheKey = this.generateKey(context);
    const cached = this.cacheStore.get(cacheKey);

    if (cached !== undefined) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('X-Cache', 'HIT');
      response.setHeader('Cache-Control', this.buildCacheControl(ttl, ttl));
      return of(cached);
    }

    return next.handle().pipe(
      tap((data) => {
        this.cacheStore.set(cacheKey, data, ttl);

        const response = context.switchToHttp().getResponse<Response>();
        response.setHeader('X-Cache', 'MISS');
        response.setHeader('Cache-Control', this.buildCacheControl(ttl, ttl));
        response.setHeader('Vary', 'Accept-Encoding');
      }),
    );
  }

  private buildCacheControl(maxAge: number, ttl: number): string {
    const swr = Math.max(ttl * 5, 300);
    return `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`;
  }

  private generateKey(context: ExecutionContext): string {
    const request = context.switchToHttp().getRequest();
    return `${request.method}:${request.url}`;
  }
}
