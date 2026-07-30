import {
  addMinutes,
  isoWeekdayOfLocalDate,
  localDateOf,
  localTimeOf,
  resolveLocal,
  timeToMinutes,
  type LocalDate,
} from '../time/zone.js';
import { MAX_COMBINATION_SIZE, findCombinations } from './combinations.js';
import { buildFloorFacts, filterTables, maxSeatableParty, type FilterContext } from './filter.js';
import { OccupancyIndex } from './occupancy.js';
import { rankAssignments, scoreAssignment } from './score.js';
import {
  datesInWindow,
  findPeriodForTime,
  generateSlotsForDate,
  isClosed,
  isWithinBookingWindow,
  servesOnDate,
  type SlotCandidate,
} from './slots.js';
import { resolveTurnTime } from './turnTime.js';
import type {
  AvailabilityQuery,
  AvailabilityResult,
  SlotOption,
  Snapshot,
  TableAssignment,
  UnavailableReason,
} from './types.js';

const DEFAULT_MAX_ALTERNATIVES = 4;
const DEFAULT_NEXT_DATES = 2;

/**
 * Days scanned when looking for the next date with space.
 *
 * A restaurant booked solid for months would otherwise make this the slowest
 * path in the system, and it is on the phone call. Thirty days of "we are
 * full" is already an answer the agent can say out loud; the caller does not
 * need us to prove it for the whole booking window.
 */
const MAX_NEXT_DATE_SCAN_DAYS = 30;

/**
 * The availability engine.
 *
 * Pure: a Snapshot in, a decision out. No database, no Redis, no clock, no
 * network, and above all no model call — the caller is on the phone and this
 * has to come back in tens of milliseconds, not seconds. Everything that needs
 * IO (loading the snapshot, taking the Redis hold, writing the reservation)
 * happens outside and around this module.
 */
export function findAvailability(
  snapshot: Snapshot,
  query: AvailabilityQuery,
): AvailabilityResult {
  const tz = snapshot.restaurant.timezone;
  const largeParty = query.partySize >= snapshot.restaurant.largePartyThreshold;
  const flexibility = query.flexibilityMinutes ?? snapshot.restaurant.flexibilityMinutes;
  const maxAlternatives = query.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES;
  const nextDateCount = query.nextDateCount ?? DEFAULT_NEXT_DATES;

  const floorsById = buildFloorFacts(snapshot.floors);
  const ctx: FilterContext = {
    floorsById,
    occupancy: new OccupancyIndex(snapshot.occupancy),
    occupancyFilter: {
      callId: query.callId ?? null,
      excludeReservationId: query.excludeReservationId ?? null,
    },
  };

  const period = findPeriodForTime(
    snapshot.servicePeriods,
    isoWeekdayOfLocalDate(query.date, tz),
    query.time,
  );
  const turnTimeMinutes = resolveTurnTime(
    query.partySize,
    snapshot.restaurant.defaultTurnTimes,
    period?.turnTimeOverrides,
  );

  const base = (
    reason: UnavailableReason | null,
    startsAt: Date | null,
    endsAt: Date | null,
  ): AvailabilityResult => ({
    available: false,
    requested: {
      localDate: query.date,
      localTime: query.time,
      startsAt,
      endsAt,
      partySize: query.partySize,
    },
    turnTimeMinutes,
    offer: null,
    alternatives: [],
    nextDates: [],
    reason,
    largeParty,
  });

  // --- Date-independent rejections, cheapest first -------------------------

  // No table or combination in the building can seat this party, on any date,
  // with these accessibility requirements. Searching 30 days would be theatre.
  const seatable = maxSeatableParty(
    snapshot.tables,
    query.accessibility,
    floorsById,
    MAX_COMBINATION_SIZE,
  );
  if (seatable < query.partySize) {
    return base('party_too_large', null, null);
  }

  if (!isWithinBookingWindow(snapshot, query.date, query.now)) {
    return base('outside_booking_window', null, null);
  }

  // --- Resolve the requested wall-clock time -------------------------------

  const resolved = resolveLocal(query.date, query.time, tz);
  if (resolved.kind === 'gap') {
    // Spring forward. This time does not exist today; offer the neighbours
    // rather than silently booking an hour later than the caller asked.
    const result = base('nonexistent_local_time', null, null);
    result.alternatives = findAlternatives(
      snapshot,
      query,
      ctx,
      resolved.skippedTo,
      flexibility,
      maxAlternatives,
      null,
    );
    return result;
  }

  const requestedStart = resolved.utc;
  const requestedEnd = addMinutes(requestedStart, turnTimeMinutes);

  if (requestedStart.getTime() < query.now.getTime()) {
    const result = base('in_the_past', requestedStart, requestedEnd);
    result.alternatives = findAlternatives(
      snapshot,
      query,
      ctx,
      requestedStart,
      flexibility,
      maxAlternatives,
      null,
    );
    return result;
  }

  // --- Is the restaurant even serving? -------------------------------------

  const closed = isClosed(snapshot.closures, requestedStart, requestedEnd);
  const isServiceTime = period !== null;

  if (closed || !isServiceTime) {
    const result = base(closed ? 'closed' : 'not_a_service_time', requestedStart, requestedEnd);
    result.alternatives = findAlternatives(
      snapshot,
      query,
      ctx,
      requestedStart,
      flexibility,
      maxAlternatives,
      null,
    );
    result.nextDates = findNextDates(snapshot, query, ctx, nextDateCount, requestedStart);
    return result;
  }

  // --- The requested slot --------------------------------------------------

  const slot: SlotCandidate = {
    startsAt: requestedStart,
    endsAt: requestedEnd,
    localDate: query.date,
    localTime: query.time,
    servicePeriodId: period.id,
    servicePeriodName: period.name,
    turnTimeMinutes,
  };

  const attempt = assignBestTable(snapshot, query, ctx, slot);

  const alternatives = findAlternatives(
    snapshot,
    query,
    ctx,
    requestedStart,
    flexibility,
    maxAlternatives,
    requestedStart,
  );

  if (attempt.assignment) {
    return {
      available: true,
      requested: {
        localDate: query.date,
        localTime: query.time,
        startsAt: requestedStart,
        endsAt: requestedEnd,
        partySize: query.partySize,
      },
      turnTimeMinutes,
      offer: toOption(slot, attempt.assignment, 0),
      alternatives,
      nextDates: [],
      reason: null,
      largeParty,
    };
  }

  const result = base(
    attempt.reason ?? (largeParty ? 'large_party_referral' : 'fully_booked'),
    requestedStart,
    requestedEnd,
  );
  result.alternatives = alternatives;
  result.nextDates =
    alternatives.length > 0
      ? []
      : findNextDates(snapshot, query, ctx, nextDateCount, requestedStart);
  return result;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

interface AssignmentAttempt {
  assignment: TableAssignment | null;
  reason: UnavailableReason | null;
}

/**
 * Best single table for the slot, or the best combination if no single table
 * fits — the order is from the spec and it is also the right order for
 * latency, since combination search only runs when it has to.
 */
export function assignBestTable(
  snapshot: Snapshot,
  query: Pick<AvailabilityQuery, 'partySize' | 'accessibility' | 'seatingPreferences'>,
  ctx: FilterContext,
  slot: Pick<SlotCandidate, 'startsAt' | 'endsAt'>,
): AssignmentAttempt {
  const outcome = filterTables(
    snapshot.tables,
    {
      partySize: query.partySize,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      accessibility: query.accessibility,
    },
    ctx,
  );

  const scoreCtx = {
    partySize: query.partySize,
    seatingPreferences: query.seatingPreferences,
    accessibility: query.accessibility,
    freePool: outcome.freeAndAccessible,
  };

  if (outcome.eligible.length > 0) {
    const ranked = rankAssignments(outcome.eligible.map((t) => scoreAssignment([t], scoreCtx)));
    return { assignment: ranked[0] ?? null, reason: null };
  }

  // No single table. Push some together.
  const combos = findCombinations(outcome.freeAndAccessible, query.partySize);
  if (combos.length > 0) {
    const ranked = rankAssignments(combos.map((c) => scoreAssignment(c.tables, scoreCtx)));
    return { assignment: ranked[0] ?? null, reason: null };
  }

  // Nothing worked. Say why in a way the agent can turn into a true sentence.
  const blockedOnlyByAccess =
    query.accessibility.length > 0 &&
    outcome.counts.accessibilityFail > 0 &&
    outcome.freeAndAccessible.length === 0;

  return {
    assignment: null,
    reason: blockedOnlyByAccess ? 'no_accessible_table' : 'fully_booked',
  };
}

// ---------------------------------------------------------------------------
// Alternatives and next dates
// ---------------------------------------------------------------------------

/**
 * Bookable times on the same local date within `flexibility` minutes either
 * side of what was asked for, nearest first.
 *
 * Ties (19:15 and 19:45 around a 19:30 request) resolve to the earlier time.
 * Guests offered a choice between equally-distant slots take the earlier one
 * far more often, and it turns the table sooner.
 */
function findAlternatives(
  snapshot: Snapshot,
  query: AvailabilityQuery,
  ctx: FilterContext,
  reference: Date,
  flexibilityMinutes: number,
  limit: number,
  excludeInstant: Date | null,
): SlotOption[] {
  if (limit <= 0 || flexibilityMinutes <= 0) return [];

  const windowMs = flexibilityMinutes * 60_000;
  const dates = new Set<LocalDate>([query.date, localDateOf(reference, snapshot.restaurant.timezone)]);

  const candidates: SlotCandidate[] = [];
  for (const date of dates) {
    if (!isWithinBookingWindow(snapshot, date, query.now)) continue;
    for (const slot of generateSlotsForDate(snapshot, date, {
      now: query.now,
      partySize: query.partySize,
    })) {
      const delta = slot.startsAt.getTime() - reference.getTime();
      if (Math.abs(delta) > windowMs) continue;
      if (excludeInstant && slot.startsAt.getTime() === excludeInstant.getTime()) continue;
      candidates.push(slot);
    }
  }

  candidates.sort((a, b) => {
    const da = Math.abs(a.startsAt.getTime() - reference.getTime());
    const db = Math.abs(b.startsAt.getTime() - reference.getTime());
    if (da !== db) return da - db;
    return a.startsAt.getTime() - b.startsAt.getTime();
  });

  const out: SlotOption[] = [];
  for (const slot of candidates) {
    if (out.length >= limit) break;
    const attempt = assignBestTable(snapshot, query, ctx, slot);
    if (!attempt.assignment) continue;
    out.push(
      toOption(slot, attempt.assignment, Math.round((slot.startsAt.getTime() - reference.getTime()) / 60_000)),
    );
  }
  return out;
}

/**
 * The next dates that can take this party, one slot each.
 *
 * The slot offered per date is the one closest to the caller's original
 * wall-clock time, so "Friday at seven thirty" becomes "Saturday at seven
 * thirty" rather than "Saturday at half past five".
 */
function findNextDates(
  snapshot: Snapshot,
  query: AvailabilityQuery,
  ctx: FilterContext,
  limit: number,
  reference: Date,
): SlotOption[] {
  if (limit <= 0) return [];
  const tz = snapshot.restaurant.timezone;
  const all = datesInWindow(snapshot, query.date, query.now, MAX_NEXT_DATE_SCAN_DAYS);
  const out: SlotOption[] = [];

  // Closest to the time they originally asked for, in wall-clock terms.
  const targetMinutes = timeToMinutes(localTimeOf(reference, tz));

  for (const date of all) {
    if (out.length >= limit) break;
    if (date === query.date) continue;
    if (!servesOnDate(snapshot, date)) continue;

    const slots = generateSlotsForDate(snapshot, date, {
      now: query.now,
      partySize: query.partySize,
    });
    if (slots.length === 0) continue;

    // Slots already carry their local time, so ordering costs no conversions.
    const ordered = [...slots].sort(
      (a, b) =>
        Math.abs(timeToMinutes(a.localTime) - targetMinutes) -
        Math.abs(timeToMinutes(b.localTime) - targetMinutes),
    );

    for (const slot of ordered) {
      const attempt = assignBestTable(snapshot, query, ctx, slot);
      if (!attempt.assignment) continue;
      out.push(
        toOption(
          slot,
          attempt.assignment,
          Math.round((slot.startsAt.getTime() - reference.getTime()) / 60_000),
        ),
      );
      break;
    }
  }

  return out;
}

function toOption(slot: SlotCandidate, assignment: TableAssignment, deltaMinutes: number): SlotOption {
  return {
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    localDate: slot.localDate,
    localTime: slot.localTime,
    servicePeriodId: slot.servicePeriodId,
    servicePeriodName: slot.servicePeriodName,
    turnTimeMinutes: slot.turnTimeMinutes,
    assignment,
    deltaMinutes,
  };
}
