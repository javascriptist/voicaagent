import { DateTime, IANAZone, Interval } from 'luxon';

/**
 * Timezone boundary.
 *
 * The rule for the whole codebase: a `Date` is always a real instant in UTC. A
 * wall-clock string like "19:30" is always in the restaurant's IANA zone and is
 * meaningless without it. This module is the only place the two are allowed to
 * meet, and it is pure — no IO, no clock reads except where `now` is passed in.
 *
 * Two DST facts drive the design:
 *
 *   Spring forward — some wall-clock times do not exist. On 2026-03-08 in
 *   America/New_York the clock jumps 01:59:59 to 03:00:00, so "02:30" is not a
 *   time. Luxon silently shifts such inputs forward to 03:30. Silently booking
 *   someone an hour later than they asked is unacceptable, so `localToUtc`
 *   reports the gap instead and the slot generator skips it.
 *
 *   Fall back — some wall-clock times happen twice. On 2026-11-01 "01:30"
 *   occurs at 05:30Z and again at 06:30Z. Luxon resolves to the first. We keep
 *   that (a restaurant offering "1:30" means the first one) but flag it, and
 *   critically we never do duration arithmetic in wall-clock terms: a 120
 *   minute turn time is 120 real minutes, computed on the UTC instant, so a
 *   booking that spans the repeated hour still occupies its table for exactly
 *   two hours.
 */

export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type LocalDate = string; // 'YYYY-MM-DD'
export type LocalTime = string; // 'HH:mm'

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function assertValidZone(zone: string): void {
  if (!isValidZone(zone)) throw new Error(`Unknown IANA timezone: ${zone}`);
}

/** Minutes since local midnight for 'HH:mm'. */
export function timeToMinutes(time: LocalTime): number {
  const m = LOCAL_TIME.exec(time);
  if (!m) throw new Error(`Invalid HH:mm time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Inverse of timeToMinutes. Wraps past midnight so 1470 becomes '00:30'. */
export function minutesToTime(minutes: number): LocalTime {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export type LocalResolution =
  | { kind: 'ok'; utc: Date }
  /** The wall clock time does not exist on this date in this zone. */
  | { kind: 'gap'; skippedTo: Date }
  /** The wall clock time exists twice. `utc` is the first (pre-transition). */
  | { kind: 'ambiguous'; utc: Date; second: Date };

/**
 * Resolve a local date and wall-clock time in a zone to a real instant.
 *
 * Callers that do not care about the distinction should use `localToUtcOrThrow`
 * (rejects gaps) or `localToUtcOrNull` (skips them).
 */
export function resolveLocal(date: LocalDate, time: LocalTime, zone: string): LocalResolution {
  if (!LOCAL_DATE.test(date)) throw new Error(`Invalid YYYY-MM-DD date: ${date}`);
  const minutes = timeToMinutes(time);
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];

  const dt = DateTime.fromObject(
    { year: y, month: mo, day: d, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    { zone },
  );
  if (!dt.isValid) throw new Error(`Invalid local time ${date} ${time} in ${zone}`);

  const wantedHour = Math.floor(minutes / 60);
  const wantedMinute = minutes % 60;

  // Luxon pushes non-existent local times forward across the gap. If the
  // round-trip does not give back what we asked for, we landed in the gap.
  if (dt.hour !== wantedHour || dt.minute !== wantedMinute || dt.day !== d) {
    return { kind: 'gap', skippedTo: dt.toJSDate() };
  }

  // During fall back, adding one real hour to an ambiguous local time lands on
  // the same wall clock reading with the other offset.
  const plusHour = dt.plus({ hours: 1 });
  if (plusHour.hour === dt.hour && plusHour.minute === dt.minute) {
    return { kind: 'ambiguous', utc: dt.toJSDate(), second: plusHour.toJSDate() };
  }

  return { kind: 'ok', utc: dt.toJSDate() };
}

/** Returns null when the wall-clock time does not exist (spring forward gap). */
export function localToUtcOrNull(date: LocalDate, time: LocalTime, zone: string): Date | null {
  const r = resolveLocal(date, time, zone);
  return r.kind === 'gap' ? null : r.utc;
}

export function localToUtcOrThrow(date: LocalDate, time: LocalTime, zone: string): Date {
  const r = resolveLocal(date, time, zone);
  if (r.kind === 'gap') {
    throw new NonExistentLocalTimeError(date, time, zone);
  }
  return r.utc;
}

export class NonExistentLocalTimeError extends Error {
  constructor(
    readonly date: LocalDate,
    readonly time: LocalTime,
    readonly zone: string,
  ) {
    super(`${date} ${time} does not exist in ${zone} (daylight saving transition)`);
    this.name = 'NonExistentLocalTimeError';
  }
}

/**
 * Parse an ISO-ish local datetime with no offset — "2026-03-08T19:30" or
 * "2026-03-08 19:30" — as wall-clock time in the given zone.
 *
 * Deliberately rejects strings carrying their own offset or a 'Z'. The voice
 * agent talks in the restaurant's local time; a caller sending "19:30Z" is
 * confused about what it is asking for, and guessing would double-book.
 */
export function parseLocalDateTime(
  input: string,
  zone: string,
): { date: LocalDate; time: LocalTime } {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(input.trim());
  if (!m) {
    throw new Error(
      `Expected a local datetime like 2026-03-08T19:30 with no timezone offset, got: ${input}`,
    );
  }
  const date = m[1] as LocalDate;
  const time = m[2] as LocalTime;
  if (!LOCAL_TIME.test(time)) throw new Error(`Invalid time in: ${input}`);
  void zone;
  return { date, time };
}

export interface LocalParts {
  date: LocalDate;
  time: LocalTime;
  /** ISO-8601 weekday: 1 Monday .. 7 Sunday. */
  weekday: number;
  /** Full offset-carrying ISO string, e.g. '2026-03-08T19:30:00.000-04:00'. */
  iso: string;
  offsetMinutes: number;
}

export function toLocalParts(instant: Date, zone: string): LocalParts {
  const dt = DateTime.fromJSDate(instant, { zone });
  return {
    date: dt.toFormat('yyyy-MM-dd'),
    time: dt.toFormat('HH:mm'),
    weekday: dt.weekday,
    iso: dt.toISO({ suppressMilliseconds: false }) ?? dt.toISO()!,
    offsetMinutes: dt.offset,
  };
}

export function localDateOf(instant: Date, zone: string): LocalDate {
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-MM-dd');
}

export function localTimeOf(instant: Date, zone: string): LocalTime {
  return DateTime.fromJSDate(instant, { zone }).toFormat('HH:mm');
}

export function isoWeekdayOf(instant: Date, zone: string): number {
  return DateTime.fromJSDate(instant, { zone }).weekday;
}

export function isoWeekdayOfLocalDate(date: LocalDate, zone: string): number {
  return DateTime.fromISO(date, { zone }).weekday;
}

/**
 * Add real minutes to an instant.
 *
 * This is plain UTC arithmetic on purpose. A two hour turn time is two hours of
 * wall time the guests actually sit there, not "the same clock reading plus
 * two", so it must not respect DST. A 01:00 booking on fall-back night ends at
 * 02:00 by the clock and has still occupied the table for two hours.
 */
export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function differenceInMinutes(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

/** Local calendar dates from `from` to `to` inclusive, at most `limit` of them. */
export function eachLocalDate(
  from: LocalDate,
  to: LocalDate,
  zone: string,
  limit = Number.POSITIVE_INFINITY,
): LocalDate[] {
  const start = DateTime.fromISO(from, { zone }).startOf('day');
  const end = DateTime.fromISO(to, { zone }).startOf('day');
  if (!start.isValid || !end.isValid) throw new Error(`Invalid date range ${from}..${to}`);
  const out: LocalDate[] = [];
  for (let d = start; d <= end && out.length < limit; d = d.plus({ days: 1 })) {
    out.push(d.toFormat('yyyy-MM-dd'));
  }
  return out;
}

/**
 * UTC milliseconds at local midnight, but only when the whole local day runs
 * at one UTC offset.
 *
 * On an ordinary day every wall-clock time is just `midnight + minutes`, and
 * computing it that way turns one Luxon conversion per slot into one per day —
 * the slot grid for a month is thousands of conversions, and this sits on the
 * phone call's critical path.
 *
 * Returns null on the two days a year the offset changes, and on the days
 * where local midnight itself does not exist (some zones transition at
 * midnight). Callers fall back to `resolveLocal` per slot there, which is the
 * exact-but-slower path. Correctness never depends on this being fast.
 */
export function uniformDayBaseMs(date: LocalDate, zone: string): number | null {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  if (!start.isValid) return null;
  // Midnight does not exist in this zone on this date.
  if (start.hour !== 0 || start.minute !== 0) return null;
  const end = start.plus({ days: 1 }).minus({ minutes: 1 });
  // A DST transition somewhere inside the day. (Two transitions in one day
  // would defeat this check; no IANA zone has ever done that.)
  if (start.offset !== end.offset) return null;
  return start.toMillis();
}

export function addLocalDays(date: LocalDate, days: number, zone: string): LocalDate {
  return DateTime.fromISO(date, { zone }).plus({ days }).toFormat('yyyy-MM-dd');
}

/** Half-open overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export function intervalOf(start: Date, end: Date): Interval {
  return Interval.fromDateTimes(DateTime.fromJSDate(start), DateTime.fromJSDate(end));
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

const ONES = [
  'twelve', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
] as const;

const MINUTE_ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const;

const MINUTE_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'] as const;

function minuteWords(m: number): string {
  if (m < 20) return MINUTE_ONES[m] ?? String(m);
  const tens = MINUTE_TENS[Math.floor(m / 10)] ?? '';
  const ones = MINUTE_ONES[m % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * A clock time as an agent should say it: "seven thirty", "eight o'clock",
 * "six oh five".
 *
 * The point of this, and of speech_hint generally, is that the model never has
 * to render structured data into words itself. It reads our sentence. A model
 * paraphrasing "19:45" as "seven forty-five PM" is fine; a model paraphrasing
 * it as "quarter to eight" and the guest hearing "eight" is a wrong booking.
 */
export function spokenTime(time: LocalTime): string {
  const minutes = timeToMinutes(time);
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hourWord = ONES[h24 % 12] ?? String(h24 % 12);
  if (m === 0) return `${hourWord} o'clock`;
  if (m < 10) return `${hourWord} oh ${minuteWords(m)}`;
  return `${hourWord} ${minuteWords(m)}`;
}

export function spokenTimeOfInstant(instant: Date, zone: string): string {
  return spokenTime(localTimeOf(instant, zone));
}

/**
 * A date as an agent should say it, relative to `today` where that reads more
 * naturally: "today", "tomorrow", "Friday the fourteenth", "the third of March".
 */
export function spokenDate(date: LocalDate, today: LocalDate, zone: string): string {
  if (date === today) return 'today';
  if (date === addLocalDays(today, 1, zone)) return 'tomorrow';
  const dt = DateTime.fromISO(date, { zone });
  const withinAWeek = dt.diff(DateTime.fromISO(today, { zone }), 'days').days < 7;
  const weekday = dt.toFormat('cccc');
  const ordinal = ordinalWords(dt.day);
  return withinAWeek ? `${weekday} the ${ordinal}` : `${weekday} the ${ordinal} of ${dt.toFormat('LLLL')}`;
}

const ORDINALS: Record<number, string> = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth',
  7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth', 11: 'eleventh',
  12: 'twelfth', 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth',
  16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth', 19: 'nineteenth',
  20: 'twentieth', 30: 'thirtieth',
};

function ordinalWords(day: number): string {
  const exact = ORDINALS[day];
  if (exact) return exact;
  const tens = Math.floor(day / 10) * 10;
  const ones = day % 10;
  const tensWord = tens === 20 ? 'twenty' : 'thirty';
  return `${tensWord} ${ORDINALS[ones] ?? String(ones)}`;
}
