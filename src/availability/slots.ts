import {
  addLocalDays,
  addMinutes,
  eachLocalDate,
  isoWeekdayOfLocalDate,
  localDateOf,
  minutesToTime,
  overlaps,
  resolveLocal,
  timeToMinutes,
  uniformDayBaseMs,
  type LocalDate,
  type LocalTime,
} from '../time/zone.js';
import { resolveTurnTime } from './turnTime.js';
import type { ClosureInput, ServicePeriodInput, Snapshot } from './types.js';

export interface SlotCandidate {
  startsAt: Date;
  localDate: LocalDate;
  localTime: LocalTime;
  servicePeriodId: string;
  servicePeriodName: string;
  turnTimeMinutes: number;
  endsAt: Date;
}

export interface SlotOptions {
  now: Date;
  partySize: number;
}

/**
 * Every bookable slot on one local calendar date.
 *
 * The grid is generated in wall-clock minutes and only then converted to real
 * instants, which is what makes DST behave. On a spring-forward date the local
 * times 02:00, 02:15, 02:30, 02:45 simply do not exist, `resolveLocal` reports
 * the gap, and those slots are dropped rather than being silently rewritten to
 * 03:00 — four slots that would otherwise all collapse onto the same instant
 * and offer the same table four times.
 *
 * A service period whose endTime is earlier than its startTime runs past
 * midnight; its late slots belong to the following local date, which is why
 * slot dates are computed per slot rather than assumed to equal `date`.
 */
export function generateSlotsForDate(
  snapshot: Snapshot,
  date: LocalDate,
  opts: SlotOptions,
): SlotCandidate[] {
  const { timezone } = snapshot.restaurant;
  const weekday = isoWeekdayOfLocalDate(date, timezone);
  const out: SlotCandidate[] = [];

  for (const period of snapshot.servicePeriods) {
    if (!period.isActive) continue;
    if (!period.daysOfWeek.includes(weekday)) continue;

    const interval = Math.max(5, period.slotIntervalMinutes || 15);
    const startMin = timeToMinutes(period.startTime);
    let endMin = timeToMinutes(period.endTime);
    // Past-midnight service: 18:00 to 01:00 means end is on the next day.
    if (endMin <= startMin) endMin += 1440;

    const lastSeatingMin = endMin + period.lastSeatingOffsetMinutes;
    if (lastSeatingMin < startMin) continue;

    const turnTimeMinutes = resolveTurnTime(
      opts.partySize,
      snapshot.restaurant.defaultTurnTimes,
      period.turnTimeOverrides,
    );

    // One Luxon conversion for the whole day when the day has no DST
    // transition, which is every day but two a year. Null means take the
    // exact, slower path per slot.
    const baseMs = uniformDayBaseMs(date, timezone);

    for (let minute = startMin; minute <= lastSeatingMin; minute += interval) {
      const dayOffset = Math.floor(minute / 1440);
      const localTime = minutesToTime(minute);
      const localDate = dayOffset === 0 ? date : addLocalDays(date, dayOffset, timezone);

      let startsAt: Date;
      if (baseMs !== null && dayOffset === 0) {
        startsAt = new Date(baseMs + minute * 60_000);
      } else {
        // Past-midnight slots land on the next local date, which may run at a
        // different offset, so they always go through the exact path.
        const resolved = resolveLocal(localDate, localTime, timezone);
        // Spring forward: this wall clock reading does not exist today.
        if (resolved.kind === 'gap') continue;
        startsAt = resolved.utc;
      }

      const endsAt = addMinutes(startsAt, turnTimeMinutes);


      if (startsAt.getTime() < opts.now.getTime()) continue;
      if (isClosed(snapshot.closures, startsAt, endsAt)) continue;

      out.push({
        startsAt,
        endsAt,
        localDate,
        localTime,
        servicePeriodId: period.id,
        servicePeriodName: period.name,
        turnTimeMinutes,
      });
    }
  }

  // Two periods can produce the same instant (an overlapping lunch and
  // all-day menu). Keep the first and sort chronologically.
  const seen = new Set<number>();
  return out
    .filter((s) => {
      const t = s.startsAt.getTime();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * A closure blocks a slot if it overlaps any part of the meal, not just the
 * arrival. Seating a table at 19:30 for two hours when the kitchen closes at
 * 20:00 for a private event is not availability.
 */
export function isClosed(closures: ClosureInput[], startsAt: Date, endsAt: Date): boolean {
  return closures.some((c) => overlaps(startsAt, endsAt, c.startsAt, c.endsAt));
}

/** Inclusive local-date bounds a query is allowed to touch. */
export function bookingWindow(
  snapshot: Snapshot,
  now: Date,
): { first: LocalDate; last: LocalDate } {
  const tz = snapshot.restaurant.timezone;
  const first = localDateOf(now, tz);
  const last = addLocalDays(first, Math.max(0, snapshot.restaurant.bookingWindowDays), tz);
  return { first, last };
}

export function isWithinBookingWindow(snapshot: Snapshot, date: LocalDate, now: Date): boolean {
  const { first, last } = bookingWindow(snapshot, now);
  return date >= first && date <= last;
}

/** Local dates from `from` forward, clamped to the booking window. */
export function datesInWindow(
  snapshot: Snapshot,
  from: LocalDate,
  now: Date,
  limit?: number,
): LocalDate[] {
  const { first, last } = bookingWindow(snapshot, now);
  const start = from < first ? first : from;
  if (start > last) return [];
  return eachLocalDate(start, last, snapshot.restaurant.timezone, limit);
}

/** Does the restaurant serve at all on this date? Cheap pre-check. */
export function servesOnDate(snapshot: Snapshot, date: LocalDate): boolean {
  const weekday = isoWeekdayOfLocalDate(date, snapshot.restaurant.timezone);
  return snapshot.servicePeriods.some((p) => p.isActive && p.daysOfWeek.includes(weekday));
}

export function findPeriodForTime(
  periods: ServicePeriodInput[],
  weekday: number,
  time: LocalTime,
): ServicePeriodInput | null {
  const minute = timeToMinutes(time);
  for (const p of periods) {
    if (!p.isActive || !p.daysOfWeek.includes(weekday)) continue;
    const start = timeToMinutes(p.startTime);
    let end = timeToMinutes(p.endTime);
    if (end <= start) end += 1440;
    const last = end + p.lastSeatingOffsetMinutes;
    const normalised = minute < start ? minute + 1440 : minute;
    if (normalised >= start && normalised <= last) return p;
  }
  return null;
}
