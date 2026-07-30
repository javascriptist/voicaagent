import { isAccessibilityAsset } from '../domain/accessibility.js';
import type { AccessibilityRequirement } from '../domain/accessibility.js';
import { matchedPreferences, type SeatingPreference } from '../domain/preferences.js';
import { buildAdjacency } from './combinations.js';
import type { ScoreBreakdown, TableAssignment, TableInput } from './types.js';

/**
 * Scoring weights.
 *
 * These are deliberately on one scale so their trade-offs are readable:
 * one satisfied preference (+10) is worth about three wasted covers (-9), and
 * an accessible table is not given away for one preference match (-15 beats
 * +10). Change one and re-read the others.
 */
export const WEIGHTS = {
  /** Per satisfied seating preference. */
  PREFERENCE_MATCH: 10,
  /** Per empty cover. Puts a party of two on a two top, not a six top. */
  CAPACITY_WASTE: -3,
  /**
   * Per cover of combinable capacity destroyed by taking this table out of a
   * free run. Small: it is a hint about future bookings, not a veto on this one.
   */
  ZONE_BALANCE: -1,
  /** Cap on the zone balance penalty, so it can never outweigh a real fit. */
  ZONE_BALANCE_CAP: 8,
  /**
   * Per accessible table used by a party with no accessibility need. Holds
   * scarce accessible inventory for guests who cannot be seated anywhere else.
   * Bigger than one preference match on purpose.
   */
  ACCESSIBILITY_RESERVE: -15,
} as const;

export interface ScoreContext {
  partySize: number;
  seatingPreferences: readonly SeatingPreference[];
  accessibility: readonly AccessibilityRequirement[];
  /** Every table free for this window, used for the zone balance term. */
  freePool: readonly TableInput[];
}

export function scoreAssignment(tables: readonly TableInput[], ctx: ScoreContext): TableAssignment {
  const attrs = tables.map((t) => t.attributes);
  const seats = tables.reduce((sum, t) => sum + t.maxCovers, 0);

  const matched = matchedPreferences(ctx.seatingPreferences, attrs);
  const unmatched = ctx.seatingPreferences.filter((p) => !matched.includes(p));

  const preferenceMatch = matched.length * WEIGHTS.PREFERENCE_MATCH;

  const wastedCovers = Math.max(0, seats - ctx.partySize);
  const capacityWaste = noNegativeZero(wastedCovers * WEIGHTS.CAPACITY_WASTE);

  const zoneBalance = zoneBalancePenalty(tables, ctx.freePool);

  // Only applies when the guest declared no accessibility need at all. A party
  // that needs a step-free table but not a wheelchair space should not be
  // pushed off an accessible table by this term.
  const accessibilityReserve =
    ctx.accessibility.length === 0
      ? noNegativeZero(attrs.filter(isAccessibilityAsset).length * WEIGHTS.ACCESSIBILITY_RESERVE)
      : 0;

  const breakdown: ScoreBreakdown = {
    preferenceMatch,
    capacityWaste,
    zoneBalance,
    accessibilityReserve,
    total: preferenceMatch + capacityWaste + zoneBalance + accessibilityReserve,
  };

  const first = tables[0]!;
  return {
    tableIds: tables.map((t) => t.id),
    labels: tables.map((t) => t.label),
    floorId: first.floorId,
    zone: first.attributes.zone,
    seats,
    isCombination: tables.length > 1,
    matchedPreferences: matched,
    unmatchedPreferences: unmatched,
    score: breakdown.total,
    breakdown,
  };
}

/**
 * Penalty for breaking up a run of free combinable tables.
 *
 * Taking table 12 out of a free run of 12–13–14 does not just cost table 12,
 * it costs the party of nine who could have had all three later that evening.
 * The penalty is the capacity of the run we can no longer offer as a unit,
 * scaled small and capped: it should break ties between otherwise similar
 * tables, never override a genuinely better fit or block the booking in front
 * of us for one that may never call.
 *
 * Assignments that use the whole run pay nothing, which is what we want —
 * that is the large party the run was being saved for.
 */
export function zoneBalancePenalty(
  assigned: readonly TableInput[],
  freePool: readonly TableInput[],
): number {
  const assignedIds = new Set(assigned.map((t) => t.id));
  const combinableAssigned = assigned.filter((t) => t.attributes.is_combinable);
  if (combinableAssigned.length === 0) return 0;

  const combinablePool = freePool.filter((t) => t.attributes.is_combinable);
  if (combinablePool.length < 2) return 0;

  const adjacency = buildAdjacency(combinablePool);
  const byId = new Map(combinablePool.map((t) => [t.id, t]));

  // The free run this assignment sits inside: the connected component of free
  // combinable tables containing it.
  const component = new Set<string>();
  const queue = [...assignedIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (component.has(id)) continue;
    if (!byId.has(id)) continue;
    component.add(id);
    for (const neighbour of adjacency.get(id) ?? []) {
      if (!component.has(neighbour)) queue.push(neighbour);
    }
  }

  const assignedCapacity = assigned.reduce((sum, t) => sum + t.maxCovers, 0);
  let runCapacity = 0;
  for (const id of component) runCapacity += byId.get(id)?.maxCovers ?? 0;

  // Only what a combination could actually have used matters, and combinations
  // cap at three tables, so a run of six does not imply a lost party of thirty.
  const usableRun = topNCapacity(component, byId, 3);
  const lost = Math.max(0, Math.min(usableRun, runCapacity) - assignedCapacity);

  return noNegativeZero(Math.min(lost, WEIGHTS.ZONE_BALANCE_CAP) * WEIGHTS.ZONE_BALANCE);
}

/**
 * Multiplying a zero count by a negative weight gives -0, which compares equal
 * to 0 but serialises and reads as "-0" in a score breakdown an operator is
 * looking at to understand why a table was chosen. Normalise it away.
 */
function noNegativeZero(n: number): number {
  return n === 0 ? 0 : n;
}

function topNCapacity(ids: Set<string>, byId: Map<string, TableInput>, n: number): number {
  const caps: number[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t) caps.push(t.maxCovers);
  }
  return caps
    .sort((a, b) => b - a)
    .slice(0, n)
    .reduce((sum, c) => sum + c, 0);
}

/**
 * Rank assignments best first.
 *
 * Ties are broken deterministically by table label so the same query always
 * returns the same table. A voice agent that offers "table 4" and then "table
 * 7" one second later on an identical re-ask sounds broken, and the caller
 * will ask which one it is.
 */
export function rankAssignments(assignments: TableAssignment[]): TableAssignment[] {
  return [...assignments].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.seats !== b.seats) return a.seats - b.seats;
    if (a.tableIds.length !== b.tableIds.length) return a.tableIds.length - b.tableIds.length;
    return a.labels.join(',').localeCompare(b.labels.join(','));
  });
}
