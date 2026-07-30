import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { BookingService } from '../booking/service.js';
import { HoldStore } from '../holds/store.js';
import { KnowledgeService } from '../knowledge/service.js';
import { buildEmbedder, buildReranker } from '../knowledge/embedder.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { buildNotifier } from '../notify/index.js';
import type { Notifier } from '../notify/notifier.js';

/**
 * Everything the routes need, assembled once.
 *
 * Passed explicitly rather than imported ad hoc so a test can hand in its own
 * database, its own clock and a no-op notifier without touching module state.
 */
export interface AppContext {
  db: PrismaClient;
  cache: Redis;
  holds: HoldStore;
  bookings: BookingService;
  knowledge: KnowledgeService;
  notifier: Notifier;
  now: () => Date;
  holdTtlSeconds: number;
  hmacWindowSeconds: number;
  webhookAuth: 'vonage_jwt' | 'hmac' | 'both';
  /** Hard ceiling per voice endpoint; Vonage AI Studio errors out at 5s. */
  voiceLatencyBudgetMs: number;
}

export function buildContext(overrides: Partial<AppContext> = {}): AppContext {
  const config = env();
  const db = overrides.db ?? prisma();
  const cache = overrides.cache ?? redis();
  const holds = overrides.holds ?? new HoldStore(cache, config.HOLD_TTL_SECONDS);
  const notifier = overrides.notifier ?? buildNotifier();
  const now = overrides.now ?? (() => new Date());

  return {
    db,
    cache,
    holds,
    notifier,
    now,
    holdTtlSeconds: overrides.holdTtlSeconds ?? config.HOLD_TTL_SECONDS,
    hmacWindowSeconds: overrides.hmacWindowSeconds ?? config.HMAC_TIMESTAMP_WINDOW_SECONDS,
    webhookAuth: overrides.webhookAuth ?? config.WEBHOOK_AUTH,
    voiceLatencyBudgetMs: overrides.voiceLatencyBudgetMs ?? config.VOICE_LATENCY_BUDGET_MS,
    bookings: overrides.bookings ?? new BookingService({ db, holds, notifier, now }),
    knowledge:
      overrides.knowledge ??
      new KnowledgeService({
        db,
        cache,
        embedder: buildEmbedder(),
        reranker: buildReranker(),
      }),
  };
}
