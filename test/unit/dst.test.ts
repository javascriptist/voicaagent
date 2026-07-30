import { describe, expect, it } from 'vitest';
import { findAvailability } from '../../src/availability/engine.js';
import type { AvailabilityQuery } from '../../src/availability/types.js';
import { localTimeOf } from '../../src/time/zone.js';
import {
  ALL_DAY,
  GROUND_FLOOR,
  NEW_YORK,
  at,
  makeSnapshot,
  makeTables,
  reservation,
} from '../fixtures/restaurant.js';

/**
 * Daylight saving, end to end through the engine.
 *
 * Two failure modes are being guarded against, and both of them book a real
 * guest at the wrong time:
 *
 *   Spring forward — the caller asks for a wall-clock time that does not
 *   exist. The naive library behaviour is to shift it silently, so the guest
 *   is told "half two" and booked for half three.
 *
 *   Fall back — the clock reads the same hour twice. Turn times computed in
 *   wall-clock terms come out an hour short, and the table is offered to
 *   someone else while the first party is still sitting at it.
 */

const TZ = NEW_YORK;
const NOW = at('2026-02-01', '09:00', TZ);

function nyRestaurant(occupancy: ReturnType<typeof reservation>[] = []) {
  const tables = makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id);
  return {
    tables,
    snapshot: makeSnapshot({
      restaurant: { timezone: TZ, bookingWindowDays: 365 },
      servicePeriods: [ALL_DAY],
      tables,
      occupancy,
    }),
  };
}

function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    partySize: 2,
    date: '2026-03-08',
    time: '19:30',
    accessibility: [],
    seatingPreferences: [],
    now: NOW,
    ...overrides,
  };
}

describe('spring forward', () => {
  // America/New_York, 2026-03-08: 01:59:59 EST is followed by 03:00:00 EDT.

  it('refuses a booking at an hour that does not exist', () => {
    const { snapshot } = nyRestaurant();
    const result = findAvailability(snapshot, query({ date: '2026-03-08', time: '02:30' }));

    expect(result.available).toBe(false);
    expect(result.reason).toBe('nonexistent_local_time');
    expect(result.offer).toBeNull();
    expect(result.requested.startsAt).toBeNull();
  });

  it('does not quietly book an hour later instead', () => {
    // This is the actual bug being prevented: Luxon resolves 02:30 to 03:30,
    // and a system that takes that at face value tells the guest half two and
    // holds a table at half three.
    const { snapshot } = nyRestaurant();
    const result = findAvailability(snapshot, query({ date: '2026-03-08', time: '02:30' }));

    for (const option of [result.offer, ...result.alternatives]) {
      if (!option) continue;
      expect(localTimeOf(option.startsAt, TZ)).not.toBe('02:30');
      expect(option.localTime).not.toBe('02:30');
    }
  });

  it('offers the real times on either side of the gap', () => {
    const { snapshot } = nyRestaurant();
    const result = findAvailability(
      snapshot,
      query({
        date: '2026-03-08',
        time: '02:30',
        flexibilityMinutes: 120,
        maxAlternatives: 12,
      }),
    );

    const times = result.alternatives.map((a) => a.localTime);
    expect(times.length).toBeGreaterThan(0);
    // Both sides of the gap are reachable...
    expect(times).toContain('03:00');
    expect(times).toContain('01:45');
    // ...but nothing inside it, because those readings are not times.
    expect(times.filter((t) => t.startsWith('02:'))).toEqual([]);
  });

  it('ranks alternatives by real elapsed time, not by clock reading', () => {
    // 03:00 EDT is fifteen real minutes after 01:45 EST despite reading an
    // hour and a quarter later, and the ordering has to reflect the former.
    const { snapshot } = nyRestaurant();
    const result = findAvailability(
      snapshot,
      query({ date: '2026-03-08', time: '02:30', flexibilityMinutes: 120, maxAlternatives: 12 }),
    );

    const deltas = result.alternatives.map((a) => Math.abs(a.deltaMinutes));
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
  });

  it('accepts the same wall clock time on the day before and after', () => {
    const { snapshot } = nyRestaurant();
    expect(findAvailability(snapshot, query({ date: '2026-03-07', time: '02:30' })).available).toBe(true);
    expect(findAvailability(snapshot, query({ date: '2026-03-09', time: '02:30' })).available).toBe(true);
  });

  it('holds the table for the full turn time across the jump', () => {
    // 01:00 EST plus two hours of real time is 04:00 EDT by the wall clock.
    const { snapshot } = nyRestaurant();
    const result = findAvailability(snapshot, query({ date: '2026-03-08', time: '01:00', partySize: 5 }));

    expect(result.available).toBe(true);
    expect(result.turnTimeMinutes).toBe(120);
    const { startsAt, endsAt } = result.offer!;
    expect(endsAt.getTime() - startsAt.getTime()).toBe(120 * 60_000);
    expect(localTimeOf(endsAt, TZ)).toBe('04:00');
  });
});

describe('fall back', () => {
  // America/New_York, 2026-11-01: 01:59:59 EDT is followed by 01:00:00 EST.

  it('books the first occurrence of the repeated hour', () => {
    const { snapshot } = nyRestaurant();
    const result = findAvailability(
      snapshot,
      query({ date: '2026-11-01', time: '01:30', partySize: 2, now: at('2026-10-01', '09:00', TZ) }),
    );

    expect(result.available).toBe(true);
    expect(result.offer!.startsAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('occupies the table for real hours, not clock hours, across the repeat', () => {
    const { snapshot } = nyRestaurant();
    const result = findAvailability(
      snapshot,
      query({ date: '2026-11-01', time: '01:00', partySize: 5, now: at('2026-10-01', '09:00', TZ) }),
    );

    const { startsAt, endsAt } = result.offer!;
    // Two hours of real time...
    expect(endsAt.getTime() - startsAt.getTime()).toBe(120 * 60_000);
    // ...but the clock only advanced one hour, because it was wound back.
    expect(localTimeOf(startsAt, TZ)).toBe('01:00');
    expect(localTimeOf(endsAt, TZ)).toBe('02:00');
    expect(startsAt.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('keeps the table blocked through the whole repeated hour', () => {
    // The bug this catches: computing occupancy in wall-clock terms makes the
    // 01:00 booking look like it ends at 02:00 "one hour later", freeing the
    // table at 01:30 EST while the party is still sitting there.
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id);
    const existing = reservation(tables[0]!.id, '2026-11-01', '01:00', 120, TZ);
    expect(existing.endsAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');

    const snapshot = makeSnapshot({
      restaurant: { timezone: TZ, bookingWindowDays: 365 },
      servicePeriods: [ALL_DAY],
      tables,
      occupancy: [existing],
    });

    const now = at('2026-10-01', '09:00', TZ);
    // The first 01:30 (05:30Z) is inside the meal.
    expect(
      findAvailability(snapshot, query({ date: '2026-11-01', time: '01:30', now })).available,
    ).toBe(false);
    // So is 01:00 itself.
    expect(
      findAvailability(snapshot, query({ date: '2026-11-01', time: '01:00', now })).available,
    ).toBe(false);
    // 02:00 is 07:00Z, exactly when the table turns.
    expect(
      findAvailability(snapshot, query({ date: '2026-11-01', time: '02:00', now })).available,
    ).toBe(true);
  });

  it('never offers the same instant under two different wall clock labels', () => {
    const { snapshot } = nyRestaurant();
    const result = findAvailability(
      snapshot,
      query({
        date: '2026-11-01',
        time: '01:00',
        flexibilityMinutes: 180,
        now: at('2026-10-01', '09:00', TZ),
      }),
    );

    const all = [result.offer, ...result.alternatives].filter((o) => o !== null);
    const instants = all.map((o) => o!.startsAt.getTime());
    expect(new Set(instants).size).toBe(instants.length);
  });
});

describe('the restaurant timezone is what counts', () => {
  it('resolves the same wall clock time differently in two zones', () => {
    const ny = nyRestaurant().snapshot;
    const london = makeSnapshot({
      restaurant: { timezone: 'Europe/London', bookingWindowDays: 365 },
      servicePeriods: [ALL_DAY],
      tables: makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id),
    });

    const nyResult = findAvailability(ny, query({ date: '2026-06-15', time: '19:30' }));
    const londonResult = findAvailability(
      london,
      query({ date: '2026-06-15', time: '19:30', now: at('2026-06-01', '09:00') }),
    );

    expect(nyResult.offer!.startsAt.toISOString()).toBe('2026-06-15T23:30:00.000Z');
    expect(londonResult.offer!.startsAt.toISOString()).toBe('2026-06-15T18:30:00.000Z');
    // Same words to the guest, five hours apart in reality.
    expect(nyResult.offer!.localTime).toBe(londonResult.offer!.localTime);
  });

  it('handles a zone with a half hour offset', () => {
    const kolkata = makeSnapshot({
      restaurant: { timezone: 'Asia/Kolkata', bookingWindowDays: 365 },
      servicePeriods: [ALL_DAY],
      tables: makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id),
    });
    const result = findAvailability(
      kolkata,
      query({ date: '2026-06-15', time: '19:30', now: at('2026-06-01', '09:00') }),
    );
    expect(result.offer!.startsAt.toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });
});
