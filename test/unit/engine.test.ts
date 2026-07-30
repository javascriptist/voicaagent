import { describe, expect, it } from 'vitest';
import { findAvailability } from '../../src/availability/engine.js';
import type { AvailabilityQuery, Snapshot, TableInput } from '../../src/availability/types.js';
import {
  DINNER,
  GROUND_FLOOR,
  UPSTAIRS,
  UPSTAIRS_WITH_LIFT,
  at,
  block,
  hold,
  makeSnapshot,
  makeTables,
  reservation,
} from '../fixtures/restaurant.js';

const NOW = at('2026-06-10', '09:00');

function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    partySize: 2,
    date: '2026-06-15',
    time: '19:30',
    accessibility: [],
    seatingPreferences: [],
    now: NOW,
    ...overrides,
  };
}

function labelsOf(snapshot: Snapshot, ids: string[]): string[] {
  return ids.map((id) => snapshot.tables.find((t) => t.id === id)?.label ?? id);
}

// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('offers a table and reports the meal window', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query());

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.offer).not.toBeNull();
    expect(result.turnTimeMinutes).toBe(90);
    expect(result.offer!.startsAt.toISOString()).toBe('2026-06-15T18:30:00.000Z');
    expect(result.offer!.endsAt.toISOString()).toBe('2026-06-15T20:00:00.000Z');
    expect(result.offer!.localTime).toBe('19:30');
    expect(result.offer!.servicePeriodName).toBe('Dinner');
  });

  it('picks the tightest table for the party', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query({ partySize: 2 }));
    // T1 is the 1-2 top; T2 (2-4) and T3 (4-6) waste covers.
    expect(labelsOf(snapshot, result.offer!.assignment.tableIds)).toEqual(['T1']);
  });

  it('respects min_covers, keeping a two top off a large table', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query({ partySize: 5 }));
    expect(labelsOf(snapshot, result.offer!.assignment.tableIds)).toEqual(['T3']);
  });
});

// ---------------------------------------------------------------------------
// Required scenario: turn time overlap
// ---------------------------------------------------------------------------

describe('turn time blocks the table for the whole meal', () => {
  function oneTable() {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id);
    return { tables, id: tables[0]!.id };
  }

  it('a two hour booking at seven blocks half eight on that table', () => {
    // A party of five gets 120 minutes from the default turn time map, so a
    // 19:00 booking owns the table until 21:00.
    const { tables, id } = oneTable();
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(id, '2026-06-15', '19:00', 120)],
    });

    const blocked = findAvailability(snapshot, query({ partySize: 5, time: '20:30' }));
    expect(blocked.available).toBe(false);
    expect(blocked.reason).toBe('fully_booked');
  });

  it('blocks every arrival inside the meal, not just the start time', () => {
    const { tables, id } = oneTable();
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(id, '2026-06-15', '19:00', 120)],
    });

    for (const time of ['19:00', '19:15', '20:00', '20:45']) {
      const result = findAvailability(snapshot, query({ partySize: 5, time }));
      expect(result.available, `${time} should be blocked`).toBe(false);
    }
  });

  it('frees the table the moment the previous meal ends', () => {
    // Half-open interval: a booking ending at 21:00 does not conflict with one
    // starting at 21:00. This has to match the tstzrange '[)' in the exclusion
    // constraint, or the engine offers slots the database then rejects.
    const { tables, id } = oneTable();
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(id, '2026-06-15', '19:00', 120)],
    });

    const result = findAvailability(snapshot, query({ partySize: 5, time: '21:00' }));
    expect(result.available).toBe(true);
  });

  it('blocks a slot whose own meal would run into an existing booking', () => {
    // Arriving at 18:00 for two hours collides with the 19:00 booking even
    // though 18:00 itself is free.
    const { tables, id } = oneTable();
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(id, '2026-06-15', '19:00', 120)],
    });

    const result = findAvailability(snapshot, query({ partySize: 5, time: '18:00' }));
    expect(result.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Required scenario: accessibility is a hard filter
// ---------------------------------------------------------------------------

describe('accessibility is never traded away', () => {
  function room() {
    const tables = makeTables(
      [
        {
          label: 'ACC',
          min: 1,
          max: 4,
          attributes: { is_wheelchair_accessible: true, has_wheelchair_clearance: true },
        },
        { label: 'P1', min: 1, max: 4 },
        { label: 'P2', min: 1, max: 4 },
        { label: 'P3', min: 1, max: 4 },
      ],
      GROUND_FLOOR.id,
    );
    return { tables, acc: tables[0]!.id };
  }

  it('returns nothing rather than a table without clearance', () => {
    const { tables, acc } = room();
    const snapshot = makeSnapshot({
      tables,
      // The one accessible table is taken all evening. Three plain tables sit
      // empty; none of them may be offered.
      occupancy: [reservation(acc, '2026-06-15', '17:00', 360)],
    });

    const result = findAvailability(
      snapshot,
      query({ partySize: 2, accessibility: ['wheelchair_space'] }),
    );

    expect(result.available).toBe(false);
    expect(result.reason).toBe('no_accessible_table');
    expect(result.offer).toBeNull();
    expect(result.alternatives).toHaveLength(0);
  });

  it('never leaks an inaccessible table through alternatives or next dates', () => {
    const { tables, acc } = room();
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(acc, '2026-06-15', '19:00', 90)],
    });

    const result = findAvailability(
      snapshot,
      query({ partySize: 2, accessibility: ['wheelchair_space'], flexibilityMinutes: 120 }),
    );

    const everyOffer = [result.offer, ...result.alternatives, ...result.nextDates].filter(
      (o): o is NonNullable<typeof o> => o !== null,
    );
    expect(everyOffer.length).toBeGreaterThan(0);
    for (const option of everyOffer) {
      for (const id of option.assignment.tableIds) {
        const table = snapshot.tables.find((t) => t.id === id)!;
        expect(table.attributes.has_wheelchair_clearance, `${table.label} lacks clearance`).toBe(true);
      }
    }
  });

  it('will not send a wheelchair user up a staircase for the last free table', () => {
    const upstairsOnly = makeTables(
      [
        {
          label: 'UP',
          min: 1,
          max: 4,
          floorId: UPSTAIRS.id,
          attributes: { is_wheelchair_accessible: true, has_wheelchair_clearance: true },
        },
      ],
      UPSTAIRS.id,
    );
    const snapshot = makeSnapshot({ floors: [UPSTAIRS], tables: upstairsOnly });

    const result = findAvailability(
      snapshot,
      query({ partySize: 2, accessibility: ['wheelchair_space'] }),
    );
    expect(result.available).toBe(false);
    // Nothing in the building can ever satisfy this, on any date.
    expect(result.reason).toBe('party_too_large');
  });

  it('accepts the same table once the floor has a lift', () => {
    const tables = makeTables(
      [
        {
          label: 'UP',
          min: 1,
          max: 4,
          floorId: UPSTAIRS_WITH_LIFT.id,
          attributes: { is_wheelchair_accessible: true, has_wheelchair_clearance: true },
        },
      ],
      UPSTAIRS_WITH_LIFT.id,
    );
    const snapshot = makeSnapshot({ floors: [UPSTAIRS_WITH_LIFT], tables });

    const result = findAvailability(
      snapshot,
      query({ partySize: 2, accessibility: ['wheelchair_space'] }),
    );
    expect(result.available).toBe(true);
  });

  it('applies the filter to every table of a combination', () => {
    const tables = makeTables(
      [
        {
          label: 'C1',
          min: 2,
          max: 4,
          attributes: {
            is_combinable: true,
            is_wheelchair_accessible: true,
            has_wheelchair_clearance: true,
          },
        },
        { label: 'C2', min: 2, max: 6, attributes: { is_combinable: true } },
      ],
      GROUND_FLOOR.id,
    );
    tables[0]!.attributes.combines_with = [tables[1]!.id];
    tables[1]!.attributes.combines_with = [tables[0]!.id];

    const snapshot = makeSnapshot({ tables });
    const result = findAvailability(
      snapshot,
      query({ partySize: 9, accessibility: ['wheelchair_space'] }),
    );

    // C2 has no clearance, so the pair cannot be offered even though it fits.
    expect(result.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Required scenario: table combination
// ---------------------------------------------------------------------------

describe('combining tables for a large party', () => {
  function room() {
    const tables = makeTables(
      [
        { label: 'M1', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
        { label: 'M2', min: 2, max: 6, attributes: { zone: 'main', is_combinable: true } },
        { label: 'T1', min: 2, max: 6, attributes: { zone: 'terrace', is_combinable: true } },
        { label: 'T2', min: 2, max: 6, attributes: { zone: 'terrace', is_combinable: true } },
        { label: 'SOLO', min: 1, max: 2 },
      ],
      GROUND_FLOOR.id,
    );
    const [m1, m2, t1, t2] = tables as [TableInput, TableInput, TableInput, TableInput];
    m1.attributes.combines_with = [m2.id];
    m2.attributes.combines_with = [m1.id];
    t1.attributes.combines_with = [t2.id];
    t2.attributes.combines_with = [t1.id];
    return { tables, m1, m2, t1, t2 };
  }

  it('gives a party of nine two combinable tables in one zone', () => {
    const snapshot = makeSnapshot({ tables: room().tables });
    const result = findAvailability(snapshot, query({ partySize: 9 }));

    expect(result.available).toBe(true);
    expect(result.offer!.assignment.isCombination).toBe(true);
    expect(result.offer!.assignment.tableIds).toHaveLength(2);
    // M1+M2 seats 10 for a party of 9; T1+T2 seats 12 and wastes three covers.
    expect(labelsOf(snapshot, result.offer!.assignment.tableIds).sort()).toEqual(['M1', 'M2']);
    expect(result.offer!.assignment.zone).toBe('main');
  });

  it('keeps a combination inside one zone', () => {
    const { tables, m1, t1 } = room();
    // Claim the main pair can be pushed against a terrace table. It cannot.
    m1.attributes.combines_with = [tables[1]!.id, t1.id];

    const snapshot = makeSnapshot({ tables });
    const result = findAvailability(snapshot, query({ partySize: 9 }));

    const zones = result.offer!.assignment.tableIds.map(
      (id) => snapshot.tables.find((t) => t.id === id)!.attributes.zone,
    );
    expect(new Set(zones).size).toBe(1);
  });

  it('lets a terrace preference outweigh the wasted covers', () => {
    const snapshot = makeSnapshot({ tables: room().tables });
    const result = findAvailability(
      snapshot,
      query({ partySize: 9, seatingPreferences: ['terrace'] }),
    );

    expect(labelsOf(snapshot, result.offer!.assignment.tableIds).sort()).toEqual(['T1', 'T2']);
    expect(result.offer!.assignment.matchedPreferences).toEqual(['terrace']);
  });

  it('only reaches for a combination when no single table fits', () => {
    const snapshot = makeSnapshot({ tables: room().tables });
    const result = findAvailability(snapshot, query({ partySize: 2 }));

    expect(result.offer!.assignment.isCombination).toBe(false);
    expect(labelsOf(snapshot, result.offer!.assignment.tableIds)).toEqual(['SOLO']);
  });

  it('flags a large party without refusing it', () => {
    const snapshot = makeSnapshot({ tables: room().tables });
    const result = findAvailability(snapshot, query({ partySize: 9 }));

    expect(result.largeParty).toBe(true);
    expect(result.available).toBe(true);
  });

  it('says the party is too large when no combination can ever seat it', () => {
    const snapshot = makeSnapshot({ tables: room().tables });
    const result = findAvailability(snapshot, query({ partySize: 40 }));

    expect(result.available).toBe(false);
    expect(result.reason).toBe('party_too_large');
    // No point offering other dates: the room will not have grown.
    expect(result.nextDates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Holds and blocks
// ---------------------------------------------------------------------------

describe('holds and blocks', () => {
  it('treats a live hold as busy', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      occupancy: [hold(tables[0]!.id, '2026-06-15', '19:30', 90, 'call-other')],
    });

    expect(findAvailability(snapshot, query()).available).toBe(false);
  });

  it('does not let a caller be blocked by their own hold', () => {
    // The agent re-checks availability mid-call all the time. Counting the
    // caller's own hold against them makes the second question fail.
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      occupancy: [hold(tables[0]!.id, '2026-06-15', '19:30', 90, 'call-mine')],
    });

    expect(findAvailability(snapshot, query({ callId: 'call-mine' })).available).toBe(true);
    expect(findAvailability(snapshot, query({ callId: 'call-theirs' })).available).toBe(false);
  });

  it('treats a maintenance block as busy', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      occupancy: [block(tables[0]!.id, '2026-06-15', '19:00', 120)],
    });

    expect(findAvailability(snapshot, query()).available).toBe(false);
  });

  it('ignores the reservation being modified', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const existing = reservation(tables[0]!.id, '2026-06-15', '19:30', 90);
    const snapshot = makeSnapshot({ tables, occupancy: [existing] });

    expect(findAvailability(snapshot, query()).available).toBe(false);
    expect(
      findAvailability(snapshot, query({ excludeReservationId: existing.reservationId })).available,
    ).toBe(true);
  });

  it('skips inactive tables', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4, isActive: false }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({ tables });
    expect(findAvailability(snapshot, query()).available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alternatives and next dates
// ---------------------------------------------------------------------------

describe('alternatives', () => {
  it('offers nearby times when the requested one is taken', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(tables[0]!.id, '2026-06-15', '19:30', 90)],
    });

    const result = findAvailability(snapshot, query({ flexibilityMinutes: 90 }));
    expect(result.available).toBe(false);
    expect(result.alternatives.length).toBeGreaterThan(0);

    // Nearest first, and none of them inside the existing meal.
    const deltas = result.alternatives.map((a) => Math.abs(a.deltaMinutes));
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
    expect(result.alternatives[0]!.localTime).toBe('18:00');
  });

  it('breaks a tie towards the earlier time', () => {
    const tables = makeTables(
      [
        { label: 'A', min: 1, max: 4 },
        { label: 'B', min: 1, max: 4 },
      ],
      GROUND_FLOOR.id,
    );
    const snapshot = makeSnapshot({ tables });
    const result = findAvailability(snapshot, query({ flexibilityMinutes: 30 }));

    expect(result.available).toBe(true);
    // 19:15 and 19:45 are both fifteen minutes away; the earlier one leads.
    expect(result.alternatives[0]!.localTime).toBe('19:15');
  });

  it('stays inside the flexibility window', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query({ flexibilityMinutes: 30 }));
    for (const alt of result.alternatives) {
      expect(Math.abs(alt.deltaMinutes)).toBeLessThanOrEqual(30);
    }
  });

  it('excludes the requested time from its own alternatives', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query());
    expect(result.alternatives.every((a) => a.deltaMinutes !== 0)).toBe(true);
  });
});

describe('next dates', () => {
  it('offers the next dates with space when the whole evening is gone', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      // Booked from open to past the last seating.
      occupancy: [reservation(tables[0]!.id, '2026-06-15', '17:00', 360)],
    });

    const result = findAvailability(snapshot, query({ flexibilityMinutes: 120 }));
    expect(result.available).toBe(false);
    expect(result.alternatives).toHaveLength(0);
    expect(result.nextDates).toHaveLength(2);
    expect(result.nextDates.map((d) => d.localDate)).toEqual(['2026-06-16', '2026-06-17']);
  });

  it('offers the same time of evening on the next date', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const snapshot = makeSnapshot({
      tables,
      occupancy: [reservation(tables[0]!.id, '2026-06-15', '17:00', 360)],
    });

    const result = findAvailability(snapshot, query({ flexibilityMinutes: 120 }));
    // "Friday at seven thirty" becomes "Saturday at seven thirty", not
    // "Saturday at five".
    expect(result.nextDates[0]!.localTime).toBe('19:30');
  });

  it('does not bother with next dates when the same evening works', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query());
    expect(result.nextDates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe('rejections', () => {
  it('rejects a date beyond the booking window', () => {
    const snapshot = makeSnapshot({ restaurant: { bookingWindowDays: 30 } });
    const result = findAvailability(snapshot, query({ date: '2026-12-25' }));
    expect(result.reason).toBe('outside_booking_window');
  });

  it('rejects a time in the past and suggests later tonight', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(
      snapshot,
      query({ date: '2026-06-15', time: '19:30', now: at('2026-06-15', '20:00') }),
    );
    expect(result.reason).toBe('in_the_past');
    expect(result.alternatives.length).toBeGreaterThan(0);
    // A slot at exactly `now` is still bookable — the engine has no opinion on
    // how much lead time a restaurant wants, that is a policy for the caller
    // to impose by passing a later `now`.
    expect(result.alternatives.every((a) => a.startsAt >= at('2026-06-15', '20:00'))).toBe(true);
  });

  it('rejects a time outside service and points at the service that day', () => {
    const snapshot = makeSnapshot();
    const result = findAvailability(snapshot, query({ time: '09:00', flexibilityMinutes: 600 }));
    expect(result.reason).toBe('not_a_service_time');
    expect(result.alternatives[0]!.localTime).toBe('17:00');
  });

  it('rejects a date the restaurant is closed', () => {
    const snapshot = makeSnapshot({
      closures: [
        { startsAt: at('2026-06-15', '00:00'), endsAt: at('2026-06-16', '00:00'), reason: 'refit' },
      ],
    });
    const result = findAvailability(snapshot, query());
    expect(result.reason).toBe('closed');
    expect(result.alternatives).toHaveLength(0);
    expect(result.nextDates.length).toBeGreaterThan(0);
  });

  it('does not serve on a day with no service period', () => {
    const mondayOnly = { ...DINNER, daysOfWeek: [1] };
    const snapshot = makeSnapshot({ servicePeriods: [mondayOnly] });
    // 2026-06-16 is a Tuesday.
    const result = findAvailability(snapshot, query({ date: '2026-06-16' }));
    expect(result.reason).toBe('not_a_service_time');
  });
});

// ---------------------------------------------------------------------------
// Determinism and cost
// ---------------------------------------------------------------------------

describe('the engine is cheap and repeatable', () => {
  function busyRestaurant() {
    const tables = makeTables(
      Array.from({ length: 20 }, (_, i) => ({
        label: `T${String(i + 1).padStart(2, '0')}`,
        min: 1,
        max: 2 + (i % 5),
        attributes: {
          zone: (['main', 'terrace', 'bar'] as const)[i % 3]!,
          is_combinable: i % 2 === 0,
        },
      })),
      GROUND_FLOOR.id,
    );
    for (let i = 0; i < tables.length - 2; i += 2) {
      tables[i]!.attributes.combines_with = [tables[i + 2]!.id];
    }
    const occupancy = tables.flatMap((t, i) =>
      i % 3 === 0 ? [reservation(t.id, '2026-06-15', '19:00', 120)] : [],
    );
    return makeSnapshot({ tables, occupancy });
  }

  it('returns the same answer for the same question', () => {
    const snapshot = busyRestaurant();
    const first = findAvailability(snapshot, query({ partySize: 4 }));
    const second = findAvailability(snapshot, query({ partySize: 4 }));
    expect(second.offer?.assignment.tableIds).toEqual(first.offer?.assignment.tableIds);
  });

  it('answers a realistic query in single-digit milliseconds', () => {
    // The whole HTTP round trip has a 500 ms p95 budget and the caller is on
    // the phone. The pure engine must be a rounding error inside that.
    const snapshot = busyRestaurant();
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      findAvailability(snapshot, query({ partySize: 4, flexibilityMinutes: 120 }));
    }
    const perQuery = (performance.now() - start) / 50;
    expect(perQuery).toBeLessThan(10);
  });

  it('stays fast on the expensive path: no availability for a month', () => {
    const tables = makeTables([{ label: 'ONLY', min: 1, max: 4 }], GROUND_FLOOR.id);
    const occupancy = Array.from({ length: 40 }, (_, i) => {
      const day = String(15 + i).padStart(2, '0');
      const month = 15 + i > 30 ? '07' : '06';
      const dayInMonth = 15 + i > 30 ? String(15 + i - 30).padStart(2, '0') : day;
      return reservation(tables[0]!.id, `2026-${month}-${dayInMonth}`, '17:00', 360);
    });
    const snapshot = makeSnapshot({ tables, occupancy });

    findAvailability(snapshot, query({ flexibilityMinutes: 120 })); // warm up
    const start = performance.now();
    for (let i = 0; i < 20; i++) findAvailability(snapshot, query({ flexibilityMinutes: 120 }));
    const perQuery = (performance.now() - start) / 20;

    const result = findAvailability(snapshot, query({ flexibilityMinutes: 120 }));
    expect(result.available).toBe(false);
    // Measures around 7 ms. The ceiling is loose enough for a noisy CI box and
    // tight enough to catch a regression like doing per-slot timezone
    // conversions again, which cost 60 ms on this same fixture.
    expect(perQuery).toBeLessThan(20);
  });
});
