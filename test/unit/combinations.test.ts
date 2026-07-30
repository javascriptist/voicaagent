import { describe, expect, it } from 'vitest';
import { buildAdjacency, findCombinations } from '../../src/availability/combinations.js';
import { GROUND_FLOOR, makeTables } from '../fixtures/restaurant.js';

/** A row of four combinable four-tops in the main room: A–B–C–D. */
function mainRow() {
  const tables = makeTables(
    [
      { label: 'A', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
      { label: 'B', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
      { label: 'C', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
      { label: 'D', min: 2, max: 4, attributes: { zone: 'main', is_combinable: true } },
    ],
    GROUND_FLOOR.id,
  );
  const [a, b, c, d] = tables as [
    (typeof tables)[number],
    (typeof tables)[number],
    (typeof tables)[number],
    (typeof tables)[number],
  ];
  a.attributes.combines_with = [b.id];
  b.attributes.combines_with = [a.id, c.id];
  c.attributes.combines_with = [b.id, d.id];
  d.attributes.combines_with = [c.id];
  return { tables, a, b, c, d };
}

const labels = (combos: { tables: { label: string }[] }[]) =>
  combos.map((c) => c.tables.map((t) => t.label).sort().join('+')).sort();

describe('adjacency', () => {
  it('treats a one-sided combines_with as an edge', () => {
    // Floor plans are hand edited; a missing reciprocal link is a typo, not a
    // statement that tables can only be pushed together in one direction.
    const { tables, a, b } = mainRow();
    a.attributes.combines_with = [b.id];
    b.attributes.combines_with = [];

    const adjacency = buildAdjacency(tables);
    expect(adjacency.get(a.id)?.has(b.id)).toBe(true);
    expect(adjacency.get(b.id)?.has(a.id)).toBe(true);
  });

  it('refuses to link across zones even when the data says to', () => {
    const { tables, a, b } = mainRow();
    b.attributes.zone = 'terrace';

    const adjacency = buildAdjacency(tables);
    expect(adjacency.get(a.id)?.has(b.id) ?? false).toBe(false);
  });

  it('ignores tables that are not marked combinable', () => {
    const { tables, a, b } = mainRow();
    b.attributes.is_combinable = false;

    const adjacency = buildAdjacency(tables);
    expect(adjacency.get(a.id)?.has(b.id) ?? false).toBe(false);
  });
});

describe('finding combinations', () => {
  it('finds every adjacent pair for a party that fits across two tables', () => {
    const { tables } = mainRow();
    const combos = labels(findCombinations(tables, 7));
    expect(combos).toContain('A+B');
    expect(combos).toContain('B+C');
    expect(combos).toContain('C+D');
    expect(combos).not.toContain('A+C');
  });

  it('offers oversized runs too and leaves the waste to the scorer', () => {
    // Three four-tops do seat a party of seven. This module answers "does it
    // fit", not "is it a good idea" — capacity waste is a scoring term, and
    // keeping the two concerns apart is what lets a full restaurant fall back
    // to a wasteful combination instead of refusing the booking.
    const { tables } = mainRow();
    const combos = labels(findCombinations(tables, 7));
    expect(combos).toContain('A+B+C');
    for (const combo of findCombinations(tables, 7)) {
      expect(combo.seats).toBeGreaterThanOrEqual(7);
    }
  });

  it('accepts a run of three connected through the middle table', () => {
    // A and C are not directly combinable, but B sits between them. Requiring
    // every pair to be adjacent would reject the commonest large party layout.
    const { tables } = mainRow();
    const combos = labels(findCombinations(tables, 10));
    expect(combos).toContain('A+B+C');
    expect(combos).toContain('B+C+D');
  });

  it('never returns more than three tables', () => {
    const { tables } = mainRow();
    // 16 covers would need all four, which the spec caps out.
    expect(findCombinations(tables, 16)).toHaveLength(0);
    for (const combo of findCombinations(tables, 9)) {
      expect(combo.tables.length).toBeLessThanOrEqual(3);
    }
  });

  it('rejects runs that are not connected', () => {
    const { tables, b, c } = mainRow();
    // Break the middle of the row: A–B  C–D.
    b.attributes.combines_with = [tables[0]!.id];
    c.attributes.combines_with = [tables[3]!.id];

    expect(labels(findCombinations(tables, 7))).toEqual(['A+B', 'C+D']);
  });

  it('uses the largest member minimum, not the sum of minimums', () => {
    // Two tables that each seat "at least two" comfortably hold three across
    // them. Summing the minimums would reject that.
    const { tables } = mainRow();
    const combos = findCombinations(tables, 3);
    expect(combos.length).toBeGreaterThan(0);
    expect(combos[0]?.minCovers).toBe(2);
  });

  it('rejects a combination too small for the party', () => {
    const { tables } = mainRow();
    // Three four-tops seat 12; a party of 13 does not fit anywhere.
    expect(findCombinations(tables, 13)).toHaveLength(0);
  });

  it('returns nothing when fewer than two tables are combinable', () => {
    const { tables } = mainRow();
    for (const t of tables.slice(1)) t.attributes.is_combinable = false;
    expect(findCombinations(tables, 8)).toHaveLength(0);
  });
});
