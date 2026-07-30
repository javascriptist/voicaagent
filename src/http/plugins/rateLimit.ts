import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';

/**
 * Fixed-window rate limiting in Redis, keyed per restaurant and route.
 *
 * Per restaurant rather than per IP: the voice platform calls from a small
 * pool of addresses shared across every tenant, so an IP limit would let one
 * busy restaurant throttle everyone else.
 *
 * Fails open. A Redis outage must not take the phone line down — the worst
 * case of not limiting for a few seconds is far cheaper than refusing every
 * caller.
 */
export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

export async function enforceRateLimit(
  cache: Redis,
  scope: string,
  key: string,
  options: RateLimitOptions,
): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
  const redisKey = `ratelimit:${scope}:${key}:${window}`;

  let count: number;
  try {
    count = await cache.incr(redisKey);
    if (count === 1) {
      await cache.expire(redisKey, options.windowSeconds + 1);
    }
  } catch {
    return; // fail open
  }

  if (count > options.limit) {
    throw new AppError(
      'rate_limited',
      `Rate limit of ${options.limit} per ${options.windowSeconds}s exceeded for ${scope}`,
      { details: { scope, limit: options.limit } },
    );
  }
}
