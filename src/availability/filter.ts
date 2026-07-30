import { satisfiesAllRequirements, type FloorFacts } from '../domain/accessibility.js';
import type { AccessibilityRequirement } from '../domain/accessibility.js';
import type { OccupancyIndex, OccupancyFilter } from './occupancy.js';
import type { FloorInput, TableInput } from './types.js';

/**
 * The hard filter. Everything here is pass/fail, never scored.
 *
 * Order matters for the diagnostics, not the result: we record why the table
 * pool emptied so the caller can say "nothing with a wheelchair space" rather
 * than the useless "no availability". The counters are the difference between
 * an agent that says something true and an agent that says something vague.
 */

export interface FilterContext {
  floorsById: Map<string, FloorFacts>;
  occupancy: OccupancyIndex;
  occupancyFilter: OccupancyFilter;
}

export interface FilterOutcome {
  /** Tables that pass every hard rule and are free for the window. */
  eligible: TableInput[];
  /**
   * Tables that pass accessibility and are free but do not fit the party.
   * These are the pool combinations are drawn from.
   */
  freeAndAccessible: TableInput[];
  counts: {
    total: number;
    inactive: number;
    capacityMismatch: number;
    accessibilityFail: number;
    busy: number;
  };
}

export function buildFloorFacts(floors: readonly FloorInput[]): Map<string, FloorFacts> {
  const map = new Map<string, FloorFacts>();
  for (const f of floors) map.set(f.id, { level: f.level, stepFreeAccess: f.stepFreeAccess });
  return map;
}

export function filterTables(
  tables: readonly TableInput[],
  params: {
    partySize: number;
    startsAt: Date;
    endsAt: Date;
    accessibility: readonly AccessibilityRequirement[];
  },
  ctx: FilterContext,
): FilterOutcome {
  const eligible: TableInput[] = [];
  const freeAndAccessible: TableInput[] = [];
  const counts = {
    total: tables.length,
    inactive: 0,
    capacityMismatch: 0,
    accessibilityFail: 0,
    busy: 0,
  };

  for (const table of tables) {
    if (!table.isActive) {
      counts.inactive++;
      continue;
    }

    // A missing floor row means the data is inconsistent. Treat the table as
    // upstairs with no step-free access rather than assuming the safe-sounding
    // ground floor: guessing wrong here puts a wheelchair user in front of a
    // staircase.
    const floor = ctx.floorsById.get(table.floorId) ?? { level: 1, stepFreeAccess: false };

    // Accessibility before capacity, so the counters distinguish "we have no
    // accessible tables" from "we have no tables that size".
    if (!satisfiesAllRequirements(params.accessibility, table.attributes, floor)) {
      counts.accessibilityFail++;
      continue;
    }

    if (!ctx.occupancy.isFree(table.id, params.startsAt, params.endsAt, ctx.occupancyFilter)) {
      counts.busy++;
      continue;
    }

    freeAndAccessible.push(table);

    // min_covers keeps a party of two off a ten top even when it is free.
    if (params.partySize < table.minCovers || params.partySize > table.maxCovers) {
      counts.capacityMismatch++;
      continue;
    }

    eligible.push(table);
  }

  return { eligible, freeAndAccessible, counts };
}

/**
 * Could this restaurant ever seat this party, ignoring time and bookings?
 *
 * Used to tell "you are too big for this room, and no date will help" apart
 * from "we are busy tonight". The former deserves a different sentence and no
 * alternative-date search.
 */
export function maxSeatableParty(
  tables: readonly TableInput[],
  accessibility: readonly AccessibilityRequirement[],
  floorsById: Map<string, FloorFacts>,
  maxCombination: number,
): number {
  const usable = tables.filter((t) => {
    if (!t.isActive) return false;
    const floor = floorsById.get(t.floorId) ?? { level: 1, stepFreeAccess: false };
    return satisfiesAllRequirements(accessibility, t.attributes, floor);
  });
  if (usable.length === 0) return 0;

  const largestSingle = Math.max(...usable.map((t) => t.maxCovers));

  // Best case for combining: the largest combinable tables in one zone.
  const byZone = new Map<string, number[]>();
  for (const t of usable) {
    if (!t.attributes.is_combinable) continue;
    const list = byZone.get(t.attributes.zone) ?? [];
    list.push(t.maxCovers);
    byZone.set(t.attributes.zone, list);
  }
  let largestCombination = 0;
  for (const caps of byZone.values()) {
    const top = caps.sort((a, b) => b - a).slice(0, maxCombination);
    largestCombination = Math.max(
      largestCombination,
      top.reduce((sum, c) => sum + c, 0),
    );
  }

  return Math.max(largestSingle, largestCombination);
}
