import type { PrismaClient } from '@prisma/client';
import { parseAttributes } from '../domain/attributes.js';
import type { HoldStore } from '../holds/store.js';
import { notFound } from '../lib/errors.js';
import { addLocalDays, localToUtcOrNull, type LocalDate } from '../time/zone.js';
import type { OccupancyInput, Snapshot, TurnTimeMap } from './types.js';

/**
 * Load everything the pure engine needs, in one round trip's worth of queries.
 *
 * Every query is scoped by restaurantId. That is not defence in depth, it is
 * the only defence: there is no row-level security behind this, so a query
 * that forgets the scope is a cross-tenant data leak. See the tenant isolation
 * test in test/integration.
 *
 * The occupancy window is bounded rather than "all future bookings". A
 * restaurant with a year of bookings would otherwise pull tens of thousands of
 * rows into a request that has 500 ms to answer.
 */

/** Days either side of the requested date to load occupancy for. */
const WINDOW_BEFORE_DAYS = 1;
const WINDOW_AFTER_DAYS = 32;

export interface SnapshotOptions {
  /** Local date the query is centred on. */
  date: LocalDate;
  /** Include live Redis holds as occupancy. Defaults to true. */
  includeHolds?: boolean;
}

export async function loadSnapshot(
  db: PrismaClient,
  holds: HoldStore | null,
  restaurantId: string,
  options: SnapshotOptions,
): Promise<Snapshot> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) throw notFound(`Restaurant ${restaurantId} not found`);

  const tz = restaurant.timezone;
  const from = boundary(addLocalDays(options.date, -WINDOW_BEFORE_DAYS, tz), tz);
  const to = boundary(addLocalDays(options.date, WINDOW_AFTER_DAYS, tz), tz);

  const [floors, tables, servicePeriods, closures, tableBlocks, reservationTables] =
    await Promise.all([
      db.floor.findMany({ where: { restaurantId } }),
      db.table.findMany({ where: { restaurantId }, orderBy: { label: 'asc' } }),
      db.servicePeriod.findMany({ where: { restaurantId, isActive: true } }),
      db.closure.findMany({
        where: { restaurantId, endsAt: { gte: from }, startsAt: { lte: to } },
      }),
      db.tableBlock.findMany({
        where: { restaurantId, endsAt: { gte: from }, startsAt: { lte: to } },
      }),
      db.reservationTable.findMany({
        where: {
          restaurantId,
          // Only live statuses occupy a table. Cancelled and no-show
          // reservations must free it, exactly as the exclusion constraint's
          // WHERE clause says.
          status: { in: ['held', 'confirmed', 'seated'] },
          endsAt: { gte: from },
          startsAt: { lte: to },
        },
        select: { tableId: true, startsAt: true, endsAt: true, reservationId: true },
      }),
    ]);

  const occupancy: OccupancyInput[] = [
    ...reservationTables.map((r) => ({
      tableId: r.tableId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      kind: 'reservation' as const,
      reservationId: r.reservationId,
    })),
    ...tableBlocks.map((b) => ({
      tableId: b.tableId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      kind: 'block' as const,
    })),
  ];

  if (holds && options.includeHolds !== false) {
    occupancy.push(...(await holds.list(restaurantId)));
  }

  return {
    restaurant: {
      id: restaurant.id,
      timezone: restaurant.timezone,
      largePartyThreshold: restaurant.largePartyThreshold,
      defaultTurnTimes: (restaurant.defaultTurnTimes ?? {}) as TurnTimeMap,
      bookingWindowDays: restaurant.bookingWindowDays,
      flexibilityMinutes: restaurant.flexibilityMinutes,
    },
    floors: floors.map((f) => ({
      id: f.id,
      name: f.name,
      level: f.level,
      stepFreeAccess: f.stepFreeAccess,
    })),
    tables: tables.map((t) => ({
      id: t.id,
      floorId: t.floorId,
      label: t.label,
      minCovers: t.minCovers,
      maxCovers: t.maxCovers,
      attributes: parseAttributes(t.attributes),
      isActive: t.isActive,
    })),
    servicePeriods: servicePeriods.map((p) => ({
      id: p.id,
      name: p.name,
      daysOfWeek: p.daysOfWeek,
      startTime: p.startTime,
      endTime: p.endTime,
      slotIntervalMinutes: p.slotIntervalMinutes,
      lastSeatingOffsetMinutes: p.lastSeatingOffsetMinutes,
      turnTimeOverrides: (p.turnTimeOverrides ?? null) as TurnTimeMap | null,
      isActive: p.isActive,
    })),
    closures: closures.map((c) => ({
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      reason: c.reason,
    })),
    occupancy,
  };
}

/**
 * Local midnight as an instant. Falls back an hour when midnight itself does
 * not exist in the zone, which happens in the handful of zones that begin DST
 * at midnight.
 */
function boundary(date: LocalDate, zone: string): Date {
  return localToUtcOrNull(date, '00:00', zone) ?? localToUtcOrNull(date, '01:00', zone)!;
}
