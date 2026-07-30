import type { TableInput } from './types.js';

/** Spec cap: never push more than three tables together. */
export const MAX_COMBINATION_SIZE = 3;

/** Safety valve so a pathological floor plan cannot blow the latency budget. */
const MAX_SUBSETS = 2_000;

export interface Combination {
  tables: TableInput[];
  seats: number;
  minCovers: number;
}

/**
 * Adjacency over combinable tables.
 *
 * `combines_with` is treated as undirected even when only one side declares
 * it. Floor plans are edited by hand and a one-sided edge is always a data
 * entry slip, never a statement that table 12 can be pushed to table 13 but
 * not the other way around. Being strict here would silently lose inventory
 * that the restaurant believes it has.
 *
 * Edges only exist between tables in the same zone, per spec: you cannot push
 * a terrace table against a bar table.
 */
export function buildAdjacency(pool: readonly TableInput[]): Map<string, Set<string>> {
  const byId = new Map(pool.map((t) => [t.id, t]));
  const adjacency = new Map<string, Set<string>>();

  const link = (a: string, b: string) => {
    const ta = byId.get(a);
    const tb = byId.get(b);
    if (!ta || !tb) return;
    if (!ta.attributes.is_combinable || !tb.attributes.is_combinable) return;
    if (ta.attributes.zone !== tb.attributes.zone) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };

  for (const table of pool) {
    if (!table.attributes.is_combinable) continue;
    if (!adjacency.has(table.id)) adjacency.set(table.id, new Set());
    for (const other of table.attributes.combines_with) link(table.id, other);
  }

  return adjacency;
}

/**
 * Combinations of 2 to `maxSize` tables that can seat the party.
 *
 * Connectivity, not cliques. Three tables in a row A–B–C work even though A and
 * C are not directly combinable, because B sits between them. Requiring every
 * pair to be adjacent would reject the most common large-party layout there is.
 *
 * The pool passed in must already be free for the window and pass the
 * accessibility filter — combinations never relax a hard rule, so a party
 * needing a wheelchair space gets a combination where *every* table has one.
 */
export function findCombinations(
  pool: readonly TableInput[],
  partySize: number,
  maxSize: number = MAX_COMBINATION_SIZE,
): Combination[] {
  const combinable = pool.filter((t) => t.attributes.is_combinable);
  if (combinable.length < 2) return [];

  const adjacency = buildAdjacency(combinable);
  const byId = new Map(combinable.map((t) => [t.id, t]));

  const seen = new Set<string>();
  let frontier: string[][] = combinable.map((t) => [t.id]);
  for (const s of frontier) seen.add(s.join('|'));

  const results: Combination[] = [];

  for (let size = 2; size <= maxSize; size++) {
    const next: string[][] = [];
    for (const subset of frontier) {
      for (const member of subset) {
        for (const neighbour of adjacency.get(member) ?? []) {
          if (subset.includes(neighbour)) continue;
          const grown = [...subset, neighbour].sort();
          const key = grown.join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(grown);
          if (seen.size > MAX_SUBSETS) break;
        }
        if (seen.size > MAX_SUBSETS) break;
      }
      if (seen.size > MAX_SUBSETS) break;
    }

    for (const subset of next) {
      const tables = subset.map((id) => byId.get(id)!).filter(Boolean);
      if (tables.length !== subset.length) continue;
      const combo = describe(tables);
      if (fits(combo, partySize)) results.push(combo);
    }

    frontier = next;
    if (frontier.length === 0) break;
  }

  return results;
}

function describe(tables: TableInput[]): Combination {
  return {
    tables,
    seats: tables.reduce((sum, t) => sum + t.maxCovers, 0),
    // The party must be at least as big as the largest member's minimum.
    // Summing the minimums would be wrong: two tables that each seat "at
    // least two" comfortably hold a party of three across them.
    minCovers: Math.max(...tables.map((t) => t.minCovers)),
  };
}

function fits(combo: Combination, partySize: number): boolean {
  return partySize >= combo.minCovers && partySize <= combo.seats;
}
