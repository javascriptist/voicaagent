import type { TurnTimeMap } from './types.js';

/** Used only if a restaurant has no usable turn time configuration at all. */
export const FALLBACK_TURN_TIME_MINUTES = 90;

/**
 * How long a party of this size occupies a table, in minutes.
 *
 * The map is sparse on purpose: a restaurant writes down the sizes it cares
 * about and lookup brackets downwards to the nearest configured size. With
 *
 *   { "default": 90, "1": 60, "2": 90, "5": 120, "8": 150 }
 *
 * a party of 6 gets 120 (the "5" bracket), a party of 9 gets 150, and a party
 * of 3 gets 90 (the "2" bracket). Bracketing down rather than up matters:
 * overestimating turn time silently removes inventory, and a restaurant that
 * configured "5": 120 meant "five or more people take two hours".
 *
 * A service period may override the restaurant defaults — lunch turns faster
 * than dinner. Two rules, because the obvious one alone is surprising:
 *
 *   An override of a size key refines that bracket only. `{ "2": 60 }` on
 *   lunch means two tops turn in an hour at lunch and everything else is
 *   unchanged.
 *
 *   An override of "default" replaces the whole policy. `{ "default": 60 }`
 *   means "lunch turns in an hour", full stop — the restaurant's dinner
 *   brackets do not leak into it. Without this rule a lunch period declaring a
 *   60 minute default would still give a party of six the two hours configured
 *   for dinner, which is not what anyone typing that meant.
 */
export function resolveTurnTime(
  partySize: number,
  base: TurnTimeMap,
  override?: TurnTimeMap | null,
): number {
  const baseMap = normalise(base);
  const overrideMap = normalise(override);

  // A period-level default supersedes the restaurant's size brackets; the
  // period's own size keys are then layered back on top.
  const inherited = 'default' in overrideMap ? { default: baseMap['default'] ?? 0 } : baseMap;
  const merged: TurnTimeMap = { ...inherited, ...overrideMap };

  const exact = merged[String(partySize)];
  if (isPositive(exact)) return exact;

  for (let size = partySize - 1; size >= 1; size--) {
    const candidate = merged[String(size)];
    if (isPositive(candidate)) return candidate;
  }

  const fallback = merged['default'];
  if (isPositive(fallback)) return fallback;

  return FALLBACK_TURN_TIME_MINUTES;
}

function isPositive(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Accept the jsonb column as it comes out of Postgres, where numbers may have
 * been written as strings by a sloppy admin client, and drop anything that is
 * not a usable duration rather than letting NaN reach the range arithmetic.
 */
function normalise(map: TurnTimeMap | null | undefined): TurnTimeMap {
  if (!map || typeof map !== 'object') return {};
  const out: TurnTimeMap = {};
  for (const [key, value] of Object.entries(map)) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}
