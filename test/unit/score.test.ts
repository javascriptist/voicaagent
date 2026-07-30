import { describe, expect, it } from 'vitest';
import { WEIGHTS, rankAssignments, scoreAssignment } from '../../src/availability/score.js';
import type { TableInput } from '../../src/availability/types.js';
import { GROUND_FLOOR, makeTables } from '../fixtures/restaurant.js';

function ctx(overrides: Partial<Parameters<typeof scoreAssignment>[1]> = {}) {
  return {
    partySize: 2,
    seatingPreferences: [] as never[],
    accessibility: [] as never[],
    freePool: [] as TableInput[],
    ...overrides,
  };
}

describe('capacity waste', () => {
  it('puts a party of two on a two top, not a six top', () => {
    const [twoTop, sixTop] = makeTables(
      [
        { label: 'two', min: 1, max: 2 },
        { label: 'six', min: 1, max: 6 },
      ],
      GROUND_FLOOR.id,
    ) as [TableInput, TableInput];

    const a = scoreAssignment([twoTop], ctx());
    const b = scoreAssignment([sixTop], ctx());

    expect(a.breakdown.capacityWaste).toBe(0);
    expect(b.breakdown.capacityWaste).toBe(4 * WEIGHTS.CAPACITY_WASTE);
    expect(rankAssignments([b, a])[0]?.labels).toEqual(['two']);
  });
});

describe('preference matching', () => {
  it('adds ten per satisfied preference', () => {
    const [booth] = makeTables(
      [{ label: 'booth', min: 1, max: 2, attributes: { seat_type: 'booth', near_window: true } }],
      GROUND_FLOOR.id,
    ) as [TableInput];

    const scored = scoreAssignment([booth], ctx({ seatingPreferences: ['booth', 'window'] }));
    expect(scored.matchedPreferences).toEqual(['booth', 'window']);
    expect(scored.breakdown.preferenceMatch).toBe(2 * WEIGHTS.PREFERENCE_MATCH);
  });

  it('reports what it could not match, so the agent can say so', () => {
    const [plain] = makeTables([{ label: 'plain', min: 1, max: 2 }], GROUND_FLOOR.id) as [TableInput];
    const scored = scoreAssignment([plain], ctx({ seatingPreferences: ['booth', 'window'] }));

    expect(scored.matchedPreferences).toEqual([]);
    expect(scored.unmatchedPreferences).toEqual(['booth', 'window']);
  });

  it('only credits a combination when every table matches', () => {
    // A party of nine given one booth and one high-stool table has not been
    // given booths, and half-crediting it would outrank two matching tables.
    const [booth, stool] = makeTables(
      [
        { label: 'booth', min: 2, max: 4, attributes: { seat_type: 'booth', is_combinable: true } },
        { label: 'stool', min: 2, max: 6, attributes: { seat_type: 'high_stool', is_combinable: true } },
      ],
      GROUND_FLOOR.id,
    ) as [TableInput, TableInput];

    const mixed = scoreAssignment([booth, stool], ctx({ partySize: 9, seatingPreferences: ['booth'] }));
    expect(mixed.matchedPreferences).toEqual([]);
  });
});

describe('accessible tables are held back', () => {
  const [accessible, plain] = makeTables(
    [
      {
        label: 'accessible',
        min: 1,
        max: 2,
        attributes: { is_wheelchair_accessible: true, has_wheelchair_clearance: true },
      },
      { label: 'plain', min: 1, max: 2 },
    ],
    GROUND_FLOOR.id,
  ) as [TableInput, TableInput];

  it('penalises an accessible table for a party with no accessibility need', () => {
    const a = scoreAssignment([accessible], ctx());
    const p = scoreAssignment([plain], ctx());

    expect(a.breakdown.accessibilityReserve).toBe(WEIGHTS.ACCESSIBILITY_RESERVE);
    expect(p.breakdown.accessibilityReserve).toBe(0);
    expect(rankAssignments([a, p])[0]?.labels).toEqual(['plain']);
  });

  it('outweighs a single preference match, so one nice-to-have does not take it', () => {
    const withPreference = scoreAssignment([accessible], ctx({ seatingPreferences: [] }));
    expect(Math.abs(WEIGHTS.ACCESSIBILITY_RESERVE)).toBeGreaterThan(WEIGHTS.PREFERENCE_MATCH);
    expect(withPreference.score).toBeLessThan(0);
  });

  it('does not penalise once the guest has declared any accessibility need', () => {
    const scored = scoreAssignment([accessible], ctx({ accessibility: ['step_free'] }));
    expect(scored.breakdown.accessibilityReserve).toBe(0);
  });
});

describe('zone balance', () => {
  function run() {
    const tables = makeTables(
      [
        { label: 'R1', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
        { label: 'R2', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
        { label: 'R3', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
        { label: 'Solo', min: 2, max: 4, attributes: { zone: 'main', is_combinable: false } },
      ],
      GROUND_FLOOR.id,
    ) as [TableInput, TableInput, TableInput, TableInput];
    const [r1, r2, r3] = tables;
    r1.attributes.combines_with = [r2.id];
    r2.attributes.combines_with = [r1.id, r3.id];
    r3.attributes.combines_with = [r2.id];
    return tables;
  }

  it('penalises taking one table out of a free run', () => {
    const tables = run();
    const scored = scoreAssignment([tables[0]], ctx({ partySize: 4, freePool: tables }));
    // The run seats 12; taking 4 of it costs the other 8, capped at the cap.
    expect(scored.breakdown.zoneBalance).toBe(WEIGHTS.ZONE_BALANCE_CAP * WEIGHTS.ZONE_BALANCE);
    expect(scored.breakdown.zoneBalance).toBeLessThan(0);
  });

  it('prefers the standalone table over one that breaks up the run', () => {
    const tables = run();
    const fromRun = scoreAssignment([tables[0]], ctx({ partySize: 4, freePool: tables }));
    const standalone = scoreAssignment([tables[3]], ctx({ partySize: 4, freePool: tables }));

    expect(rankAssignments([fromRun, standalone])[0]?.labels).toEqual(['Solo']);
  });

  it('charges nothing when the party uses the whole run', () => {
    // This is the large party the run was being kept for.
    const tables = run();
    const scored = scoreAssignment(
      [tables[0], tables[1], tables[2]],
      ctx({ partySize: 11, freePool: tables }),
    );
    expect(scored.breakdown.zoneBalance).toBe(0);
  });

  it('charges nothing when the neighbours are already taken', () => {
    const tables = run();
    // Only R1 is free; there is no run left to break up.
    const scored = scoreAssignment([tables[0]], ctx({ partySize: 4, freePool: [tables[0]] }));
    expect(scored.breakdown.zoneBalance).toBe(0);
  });

  it('stays small enough that a real fit still wins', () => {
    // A party of two on a two top outside the run must beat a two top inside
    // it, but the penalty must never be big enough to reject a table that is
    // the only sensible fit.
    expect(Math.abs(WEIGHTS.ZONE_BALANCE_CAP * WEIGHTS.ZONE_BALANCE)).toBeLessThan(
      Math.abs(WEIGHTS.ACCESSIBILITY_RESERVE),
    );
  });
});

describe('ranking is deterministic', () => {
  it('breaks ties by label so the same query always names the same table', () => {
    const [t1, t2] = makeTables(
      [
        { label: 'B12', min: 1, max: 2 },
        { label: 'A04', min: 1, max: 2 },
      ],
      GROUND_FLOOR.id,
    ) as [TableInput, TableInput];

    const a = scoreAssignment([t1], ctx());
    const b = scoreAssignment([t2], ctx());
    expect(a.score).toBe(b.score);
    expect(rankAssignments([a, b])[0]?.labels).toEqual(['A04']);
    expect(rankAssignments([b, a])[0]?.labels).toEqual(['A04']);
  });

  it('prefers a single table to a combination at equal score', () => {
    const [single, c1, c2] = makeTables(
      [
        { label: 'S', min: 2, max: 4 },
        { label: 'C1', min: 2, max: 2, attributes: { is_combinable: true } },
        { label: 'C2', min: 2, max: 2, attributes: { is_combinable: true } },
      ],
      GROUND_FLOOR.id,
    ) as [TableInput, TableInput, TableInput];

    const combo = scoreAssignment([c1, c2], ctx({ partySize: 4 }));
    const solo = scoreAssignment([single], ctx({ partySize: 4 }));
    expect(combo.score).toBe(solo.score);
    expect(rankAssignments([combo, solo])[0]?.isCombination).toBe(false);
  });
});
