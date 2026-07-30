import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { HoldStore } from '../../src/holds/store.js';
import { BookingService } from '../../src/booking/service.js';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { NoopEmbedder, NoopReranker } from '../../src/knowledge/embedder.js';
import { NoopNotifier } from '../../src/notify/notifier.js';
import { signedHeaders } from '../../src/lib/hmac.js';
import { signVonageWebhook } from '../../src/lib/vonage.js';
import type { TableAttributes, Zone } from '../../src/domain/attributes.js';

/**
 * Integration test harness.
 *
 * These tests need a real Postgres, because the thing under test *is* the
 * database: the exclusion constraint, the sync trigger, the unique index on
 * idempotency keys. Mocking any of that would test the mock.
 *
 * When Postgres is not reachable the suites skip rather than fail, so
 * `npm test` still works on a laptop without docker running. `DB_REQUIRED=1`
 * turns a missing database into a failure instead, which is what CI sets.
 */

process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'test-secret-at-least-sixteen-chars';
process.env.DATABASE_URL ??= 'postgresql://aicc:aicc@localhost:5433/aicc?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.NOTIFIER = 'noop';
process.env.OPENAI_API_KEY = '';

export const DB_REQUIRED = process.env.DB_REQUIRED === '1';

let cachedDb: PrismaClient | null = null;
let cachedRedis: Redis | null = null;

export async function probeInfrastructure(): Promise<{
  ok: boolean;
  reason: string | null;
  db: PrismaClient | null;
  cache: Redis | null;
}> {
  try {
    const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    await db.$queryRaw`SELECT 1`;

    // The constraint and the extension are the point of these tests. If the
    // migrations have not run, skipping is more honest than a confusing
    // failure fifteen assertions later.
    const constraint = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = 'reservation_tables_no_overlap'
    `;
    if (constraint.length === 0) {
      await db.$disconnect();
      return {
        ok: false,
        reason: 'migrations have not been applied (reservation_tables_no_overlap is missing)',
        db: null,
        cache: null,
      };
    }

    const cache = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      lazyConnect: true,
    });
    await cache.connect();
    await cache.ping();

    cachedDb = db;
    cachedRedis = cache;
    return { ok: true, reason: null, db, cache };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, db: null, cache: null };
  }
}

export const infra = await probeInfrastructure();

if (!infra.ok) {
  const message = `Integration tests skipped: ${infra.reason}`;
  if (DB_REQUIRED) throw new Error(message);
  console.warn(`\n  ${message}\n  Run: docker compose up -d && npm run prisma:migrate\n`);
}

export const db = infra.db as PrismaClient;
export const cache = infra.cache as Redis;

export async function teardown(): Promise<void> {
  await cachedDb?.$disconnect().catch(() => undefined);
  await cachedRedis?.quit().catch(() => undefined);
  cachedDb = null;
  cachedRedis = null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function attrs(overrides: Partial<TableAttributes> & { zone: Zone }): TableAttributes {
  return {
    seat_type: 'chair',
    is_wheelchair_accessible: false,
    has_wheelchair_clearance: false,
    near_window: false,
    near_entrance: false,
    near_toilets: false,
    near_kitchen: false,
    near_speakers: false,
    noise_level: 'normal',
    is_combinable: false,
    combines_with: [],
    ...overrides,
  };
}

export interface SeededRestaurant {
  id: string;
  slug: string;
  hmacSecret: string;
  groundFloorId: string;
  upstairsFloorId: string;
  tableIds: Record<string, string>;
}

export interface SeedOptions {
  timezone?: string;
  slugPrefix?: string;
  /** Adds a combinable run and an accessible table. Default true. */
  rich?: boolean;
}

/**
 * A small restaurant, unique per call.
 *
 * Every suite seeds its own so they cannot interfere, which also means the
 * tenant isolation test gets two genuinely separate tenants for free.
 */
export async function seedRestaurant(options: SeedOptions = {}): Promise<SeededRestaurant> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `${options.slugPrefix ?? 'test'}-${suffix}`;
  const hmacSecret = `secret-${suffix}`;

  const restaurant = await db.restaurant.create({
    data: {
      name: `Test ${suffix}`,
      slug,
      timezone: options.timezone ?? 'Europe/London',
      phone: '+441234567890',
      largePartyThreshold: 8,
      defaultTurnTimes: { default: 90, '1': 60, '2': 90, '5': 120, '8': 150 },
      bookingWindowDays: 90,
      flexibilityMinutes: 60,
      cancellationPolicy: 'Four hours notice please.',
      hmacSecret,
    },
  });

  const ground = await db.floor.create({
    data: { restaurantId: restaurant.id, name: 'Ground', level: 0, stepFreeAccess: true },
  });
  const upstairs = await db.floor.create({
    data: { restaurantId: restaurant.id, name: 'Upstairs', level: 1, stepFreeAccess: false },
  });

  await db.servicePeriod.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Dinner',
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: '17:00',
      endTime: '23:00',
      slotIntervalMinutes: 15,
      lastSeatingOffsetMinutes: -60,
    },
  });

  const specs: Array<{ label: string; min: number; max: number; floorId: string; a: TableAttributes; combines?: string[] }> = [
    { label: 'SOLO', min: 1, max: 4, floorId: ground.id, a: attrs({ zone: 'main' }) },
    { label: 'PLAIN1', min: 1, max: 4, floorId: ground.id, a: attrs({ zone: 'main' }) },
    { label: 'PLAIN2', min: 1, max: 4, floorId: ground.id, a: attrs({ zone: 'main', seat_type: 'booth' }) },
  ];

  if (options.rich !== false) {
    specs.push(
      {
        label: 'ACC',
        min: 1,
        max: 4,
        floorId: ground.id,
        a: attrs({ zone: 'main', is_wheelchair_accessible: true, has_wheelchair_clearance: true }),
      },
      { label: 'UP1', min: 2, max: 4, floorId: upstairs.id, a: attrs({ zone: 'mezzanine' }) },
      { label: 'C1', min: 2, max: 4, floorId: ground.id, a: attrs({ zone: 'terrace', is_combinable: true }), combines: ['C2'] },
      { label: 'C2', min: 2, max: 6, floorId: ground.id, a: attrs({ zone: 'terrace', is_combinable: true }), combines: ['C1'] },
    );
  }

  const tableIds: Record<string, string> = {};
  for (const [i, spec] of specs.entries()) {
    const table = await db.table.create({
      data: {
        restaurantId: restaurant.id,
        floorId: spec.floorId,
        label: spec.label,
        minCovers: spec.min,
        maxCovers: spec.max,
        shape: 'rectangle',
        x: i * 80,
        y: 0,
        width: 60,
        height: 60,
        attributes: { ...spec.a, combines_with: [] },
      },
    });
    tableIds[spec.label] = table.id;
  }

  for (const spec of specs) {
    if (!spec.combines?.length) continue;
    await db.table.update({
      where: { id: tableIds[spec.label]! },
      data: {
        attributes: {
          ...spec.a,
          combines_with: spec.combines.map((l) => tableIds[l]!).filter(Boolean),
        },
      },
    });
  }

  return {
    id: restaurant.id,
    slug,
    hmacSecret,
    groundFloorId: ground.id,
    upstairsFloorId: upstairs.id,
    tableIds,
  };
}

export async function deleteRestaurant(id: string): Promise<void> {
  // Cascades take care of floors, tables, reservations and the rest.
  await db.restaurant.delete({ where: { id } }).catch(() => undefined);
}

export async function clearHolds(restaurantId: string): Promise<void> {
  const keys = await cache.keys(`hold:${restaurantId}:*`);
  if (keys.length > 0) await cache.del(...keys);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface TestApp {
  app: FastifyInstance;
  notifier: NoopNotifier;
  holds: HoldStore;
  close(): Promise<void>;
}

export async function buildTestApp(
  overrides: { now?: () => Date; holdTtlSeconds?: number } = {},
): Promise<TestApp> {
  const notifier = new NoopNotifier();
  const holds = new HoldStore(cache, overrides.holdTtlSeconds ?? 180);
  const now = overrides.now ?? (() => new Date());

  const app = await buildApp({
    context: {
      db,
      cache,
      holds,
      notifier,
      now,
      holdTtlSeconds: overrides.holdTtlSeconds ?? 180,
      bookings: new BookingService({ db, holds, notifier, now }),
      knowledge: new KnowledgeService({
        db,
        cache,
        embedder: new NoopEmbedder(),
        reranker: new NoopReranker(),
      }),
    },
  });
  await app.ready();

  return {
    app,
    notifier,
    holds,
    close: async () => {
      await app.close();
    },
  };
}

/** Build the headers a signed voice request needs. */
export function voiceHeaders(
  restaurant: SeededRestaurant,
  body: unknown,
  options: { idempotencyKey?: string; scheme?: 'hmac' | 'vonage'; now?: Date } = {},
): Record<string, string> {
  const raw = JSON.stringify(body);
  const now = options.now ?? new Date();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-restaurant': restaurant.slug,
  };

  if (options.scheme === 'vonage') {
    headers.authorization = `Bearer ${signVonageWebhook(restaurant.hmacSecret, raw, now)}`;
  } else {
    Object.assign(headers, signedHeaders(restaurant.hmacSecret, raw, now));
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return headers;
}

/** POST a signed voice request. Body is serialised exactly once, so the signature matches. */
export async function voicePost(
  test: TestApp,
  restaurant: SeededRestaurant,
  path: string,
  body: unknown,
  options: { idempotencyKey?: string; scheme?: 'hmac' | 'vonage'; now?: Date } = {},
) {
  const payload = JSON.stringify(body);
  return test.app.inject({
    method: 'POST',
    url: `/v1/voice${path}`,
    headers: voiceHeaders(restaurant, body, options),
    payload,
  });
}

/** The next occurrence of a weekday, so tests never depend on today's date. */
export function upcomingDate(daysAhead = 14): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
