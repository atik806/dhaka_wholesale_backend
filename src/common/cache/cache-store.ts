import { Injectable } from '@nestjs/common';

interface CacheEntry {
  data: unknown;
  expiry: number;
}

const MAX_ENTRIES = 500;

@Injectable()
export class CacheStore {
  private readonly cache = new Map<string, CacheEntry>();

  get(key: string): unknown {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiry <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, data: unknown, ttlSeconds: number): void {
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  /** Remove every entry whose key starts with the given prefix (e.g. 'GET:/products'). */
  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
