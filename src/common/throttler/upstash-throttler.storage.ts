import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from '@upstash/redis';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

const KEY_PREFIX = 'dw:throttle';

// One round trip, atomic across every serverless instance. Fixed window per
// key: the first hit starts the window, exceeding `limit` sets a separate block
// key for `blockDuration`. While blocked, hits are not counted (same as the
// in-memory ThrottlerStorageService).
// Returns { totalHits, windowMs, isBlocked (0/1), blockMs }.
const INCREMENT_SCRIPT = `
local blockMs = redis.call('PTTL', KEYS[2])
if blockMs > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { hits, redis.call('PTTL', KEYS[1]), 1, blockMs }
end
local hits = redis.call('INCR', KEYS[1])
local windowMs = redis.call('PTTL', KEYS[1])
if windowMs < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  windowMs = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, windowMs, 1, tonumber(ARGV[3]) }
end
return { hits, windowMs, 0, 0 }
`;

/**
 * Rate-limit counters shared by every API instance via Upstash Redis (HTTP,
 * so it works on Vercel serverless where TCP Redis connections don't).
 *
 * The default in-memory storage keeps per-instance counters that reset on
 * every cold start, so on serverless the limits on login/register/contact
 * barely apply. Fails open to an in-memory store if Redis is unreachable —
 * degraded limiting beats taking the whole API down.
 */
export class UpstashThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(UpstashThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private lastErrorLoggedAt = 0;

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${KEY_PREFIX}:${throttlerName}:${key}`;
    try {
      const [totalHits, windowMs, blocked, blockMs] = await this.redis.eval<
        string[],
        [number, number, number, number]
      >(
        INCREMENT_SCRIPT,
        [`${base}:hits`, `${base}:block`],
        [String(ttl), String(limit), String(blockDuration)],
      );
      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(windowMs / 1000)),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.max(0, Math.ceil(blockMs / 1000)),
      };
    } catch (err) {
      // Log at most once a minute so a Redis outage doesn't flood the logs.
      if (Date.now() - this.lastErrorLoggedAt > 60_000) {
        this.lastErrorLoggedAt = Date.now();
        this.logger.error(
          `Upstash rate-limit storage failed, using in-memory fallback: ${(err as Error).message}`,
        );
      }
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }
}

/**
 * Upstash storage when UPSTASH_REDIS_REST_URL/TOKEN are set (production),
 * otherwise undefined so ThrottlerModule uses its default in-memory store
 * (local dev, tests).
 */
export function createThrottlerStorage(): ThrottlerStorage | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.VERCEL) {
      new Logger('Throttler').warn(
        'UPSTASH_REDIS_REST_URL/TOKEN not set — rate limits are per-instance and unreliable on serverless.',
      );
    }
    return undefined;
  }
  return new UpstashThrottlerStorage(new Redis({ url, token }));
}
