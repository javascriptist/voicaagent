import { describe, expect, it } from 'vitest';
import { generateSlotsForDate, isWithinBookingWindow } from '../../src/availability/slots.js';
import {
  ALL_DAY,
  DINNER,
  LUNCH,
  NEW_YORK,
  at,
  makeSnapshot,
} from '../fixtures/restaurant.js';

const NOW = at('2026-06-01', '09:00');

describe('slot grid', () => {
  it('runs from opening to the last seating, not to closing', () => {
    // Dinner 17:00-23:00 with a -60 last seating offset: 17:00 through 22:00.
    const snapshot = makeSnapshot({ servicePeriods: [DINNER] });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 });

    expect(slots[0]?.localTime).toBe('17:00');
    expect(slots.at(-1)?.localTime).toBe('22:00');
    expect(slots).toHaveLength(21);
  });

  it('skips days the period does not run', () => {
    const mondayOnly = { ...DINNER, daysOfWeek: [1] };
    const snapshot = makeSnapshot({ servicePeriods: [mondayOnly] });

    // 2026-06-15 is a Monday, 2026-06-16 a Tuesday.
    expect(generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 })).not.toHaveLength(0);
    expect(generateSlotsForDate(snapshot, '2026-06-16', { now: NOW, partySize: 2 })).toHaveLength(0);
  });

  it('merges two periods and de-duplicates shared instants', () => {
    const snapshot = makeSnapshot({ servicePeriods: [LUNCH, DINNER] });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 });
    const times = slots.map((s) => s.localTime);

    expect(times).toContain('12:00');
    expect(times).toContain('19:30');
    expect(new Set(times).size).toBe(times.length);
    // Sorted chronologically regardless of which period produced them.
    expect(times).toEqual([...times].sort());
  });

  it('carries a past-midnight period onto the next local date', () => {
    const lateNight = {
      ...DINNER,
      startTime: '18:00',
      endTime: '01:00',
      lastSeatingOffsetMinutes: -30,
    };
    const snapshot = makeSnapshot({ servicePeriods: [lateNight] });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 });

    expect(slots.at(-1)?.localTime).toBe('00:30');
    expect(slots.at(-1)?.localDate).toBe('2026-06-16');
  });

  it('drops slots that have already passed', () => {
    const snapshot = makeSnapshot({ servicePeriods: [DINNER] });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', {
      now: at('2026-06-15', '19:07'),
      partySize: 2,
    });
    expect(slots[0]?.localTime).toBe('19:15');
  });

  it('drops slots whose meal would run into a closure', () => {
    const snapshot = makeSnapshot({
      servicePeriods: [DINNER],
      closures: [
        { startsAt: at('2026-06-15', '20:00'), endsAt: at('2026-06-15', '23:59'), reason: 'private hire' },
      ],
    });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 });

    // A 90 minute turn at 18:45 ends at 20:15, which is inside the closure, so
    // the last usable arrival is 18:30. Blocking only the arrival time would
    // have seated a table into an event.
    expect(slots.at(-1)?.localTime).toBe('18:30');
  });

  it('uses the period turn time override when computing the meal window', () => {
    const snapshot = makeSnapshot({ servicePeriods: [LUNCH] });
    const slots = generateSlotsForDate(snapshot, '2026-06-15', { now: NOW, partySize: 2 });
    // Lunch overrides everything to 60 minutes.
    expect(slots[0]?.turnTimeMinutes).toBe(60);
  });
});

describe('slot grid across daylight saving', () => {
  it('omits the wall clock hour that does not exist on the spring forward date', () => {
    const snapshot = makeSnapshot({
      restaurant: { timezone: NEW_YORK },
      servicePeriods: [ALL_DAY],
    });

    const normal = generateSlotsForDate(snapshot, '2026-03-07', {
      now: at('2026-03-01', '00:00', NEW_YORK),
      partySize: 2,
    });
    const springForward = generateSlotsForDate(snapshot, '2026-03-08', {
      now: at('2026-03-01', '00:00', NEW_YORK),
      partySize: 2,
    });

    expect(normal).toHaveLength(96);
    // 02:00, 02:15, 02:30 and 02:45 are not times on 2026-03-08.
    expect(springForward).toHaveLength(92);

    const times = springForward.map((s) => s.localTime);
    expect(times).not.toContain('02:00');
    expect(times).not.toContain('02:30');
    expect(times).toContain('01:45');
    expect(times).toContain('03:00');
  });

  it('never offers two slots that are the same instant', () => {
    const snapshot = makeSnapshot({
      restaurant: { timezone: NEW_YORK },
      servicePeriods: [ALL_DAY],
    });
    const slots = generateSlotsForDate(snapshot, '2026-03-08', {
      now: at('2026-03-01', '00:00', NEW_YORK),
      partySize: 2,
    });

    // The failure this guards against: mapping the gap forward instead of
    // skipping it, which collapses 02:00/02:15/02:30/02:45 onto 03:00 and
    // offers the same table four times under four different names.
    const instants = slots.map((s) => s.startsAt.getTime());
    expect(new Set(instants).size).toBe(instants.length);
  });

  it('offers the repeated hour once on the fall back date', () => {
    const snapshot = makeSnapshot({
      restaurant: { timezone: NEW_YORK },
      servicePeriods: [ALL_DAY],
    });
    const slots = generateSlotsForDate(snapshot, '2026-11-01', {
      now: at('2026-10-01', '00:00', NEW_YORK),
      partySize: 2,
    });

    // The day is 25 hours long, but the wall clock only reads 96 distinct
    // quarter hours. We offer each reading once, taking the first occurrence,
    // because "come at half one" cannot mean two different instants to a guest.
    expect(slots).toHaveLength(96);
    expect(slots.filter((s) => s.localTime === '01:30')).toHaveLength(1);
    const instants = slots.map((s) => s.startsAt.getTime());
    expect(new Set(instants).size).toBe(instants.length);
  });
});

describe('booking window', () => {
  it('accepts today and the last day, rejects beyond', () => {
    const snapshot = makeSnapshot({ restaurant: { bookingWindowDays: 30 } });
    const now = at('2026-06-01', '09:00');

    expect(isWithinBookingWindow(snapshot, '2026-06-01', now)).toBe(true);
    expect(isWithinBookingWindow(snapshot, '2026-07-01', now)).toBe(true);
    expect(isWithinBookingWindow(snapshot, '2026-07-02', now)).toBe(false);
    expect(isWithinBookingWindow(snapshot, '2026-05-31', now)).toBe(false);
  });
});
