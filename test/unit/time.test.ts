import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  eachLocalDate,
  localDateOf,
  localTimeOf,
  minutesToTime,
  parseLocalDateTime,
  resolveLocal,
  spokenDate,
  spokenTime,
  timeToMinutes,
} from '../../src/time/zone.js';

const NY = 'America/New_York';
const LDN = 'Europe/London';

describe('wall clock to instant', () => {
  it('resolves an ordinary time', () => {
    const r = resolveLocal('2026-06-15', '19:30', LDN);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    // BST, UTC+1.
    expect(r.utc.toISOString()).toBe('2026-06-15T18:30:00.000Z');
  });

  it('round trips through the zone', () => {
    const instant = resolveLocal('2026-01-15', '19:30', LDN);
    expect(instant.kind).toBe('ok');
    if (instant.kind !== 'ok') return;
    expect(localTimeOf(instant.utc, LDN)).toBe('19:30');
    expect(localDateOf(instant.utc, LDN)).toBe('2026-01-15');
  });
});

describe('spring forward', () => {
  // New York 2026-03-08: 01:59:59 EST is followed by 03:00:00 EDT.
  it('reports 02:30 on the transition date as a gap, not a shifted time', () => {
    const r = resolveLocal('2026-03-08', '02:30', NY);
    expect(r.kind).toBe('gap');
  });

  it('does not silently move the booking an hour later', () => {
    const r = resolveLocal('2026-03-08', '02:30', NY);
    if (r.kind !== 'gap') throw new Error('expected a gap');
    // Luxon would have handed us 03:30. Confirming that is exactly the trap.
    expect(localTimeOf(r.skippedTo, NY)).toBe('03:30');
  });

  it('accepts the times on either side of the gap', () => {
    expect(resolveLocal('2026-03-08', '01:45', NY).kind).toBe('ok');
    expect(resolveLocal('2026-03-08', '03:00', NY).kind).toBe('ok');
  });

  it('handles the London transition too, a different date', () => {
    // Europe/London springs forward 2026-03-29 at 01:00.
    expect(resolveLocal('2026-03-29', '01:30', LDN).kind).toBe('gap');
    expect(resolveLocal('2026-03-08', '01:30', LDN).kind).toBe('ok');
  });

  it('leaves the day before and after alone', () => {
    expect(resolveLocal('2026-03-07', '02:30', NY).kind).toBe('ok');
    expect(resolveLocal('2026-03-09', '02:30', NY).kind).toBe('ok');
  });
});

describe('fall back', () => {
  // New York 2026-11-01: 01:59:59 EDT is followed by 01:00:00 EST.
  it('flags the repeated hour as ambiguous and picks the first occurrence', () => {
    const r = resolveLocal('2026-11-01', '01:30', NY);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.utc.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(r.second.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    // Both really are 01:30 by the wall clock. That is the whole problem.
    expect(localTimeOf(r.utc, NY)).toBe('01:30');
    expect(localTimeOf(r.second, NY)).toBe('01:30');
  });

  it('treats the hour before and after as unambiguous', () => {
    expect(resolveLocal('2026-11-01', '00:30', NY).kind).toBe('ok');
    expect(resolveLocal('2026-11-01', '03:30', NY).kind).toBe('ok');
  });
});

describe('duration arithmetic is real time, not wall clock', () => {
  it('a two hour booking across the repeated hour lasts two hours', () => {
    const r = resolveLocal('2026-11-01', '01:00', NY);
    if (r.kind !== 'ambiguous') throw new Error('expected the repeated hour');
    const end = addMinutes(r.utc, 120);

    expect(end.getTime() - r.utc.getTime()).toBe(120 * 60_000);
    // The clock on the wall only advanced one hour, because it was wound back.
    expect(localTimeOf(r.utc, NY)).toBe('01:00');
    expect(localTimeOf(end, NY)).toBe('02:00');
  });

  it('a two hour booking across the gap also lasts two hours', () => {
    const r = resolveLocal('2026-03-08', '01:00', NY);
    if (r.kind !== 'ok') throw new Error('expected a normal time');
    const end = addMinutes(r.utc, 120);

    expect(end.getTime() - r.utc.getTime()).toBe(120 * 60_000);
    // The clock jumped forward, so it reads four hours later.
    expect(localTimeOf(end, NY)).toBe('04:00');
  });
});

describe('parsing', () => {
  it('accepts local datetimes with no offset', () => {
    expect(parseLocalDateTime('2026-03-08T19:30', NY)).toEqual({
      date: '2026-03-08',
      time: '19:30',
    });
    expect(parseLocalDateTime('2026-03-08 19:30:00', NY)).toEqual({
      date: '2026-03-08',
      time: '19:30',
    });
  });

  it('rejects anything carrying its own offset', () => {
    // Accepting these would mean guessing whether the caller meant UTC or the
    // restaurant's clock, and guessing wrong books the wrong hour.
    expect(() => parseLocalDateTime('2026-03-08T19:30Z', NY)).toThrow();
    expect(() => parseLocalDateTime('2026-03-08T19:30+01:00', NY)).toThrow();
  });
});

describe('minute helpers', () => {
  it('converts both ways', () => {
    expect(timeToMinutes('19:30')).toBe(1170);
    expect(minutesToTime(1170)).toBe('19:30');
  });

  it('wraps past midnight for late service periods', () => {
    expect(minutesToTime(1470)).toBe('00:30');
    expect(minutesToTime(1440)).toBe('00:00');
  });

  it('enumerates local dates inclusively', () => {
    expect(eachLocalDate('2026-03-07', '2026-03-10', NY)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('enumerates across a DST boundary without losing or repeating a day', () => {
    const dates = eachLocalDate('2026-03-06', '2026-03-11', NY);
    expect(dates).toHaveLength(6);
    expect(new Set(dates).size).toBe(6);
  });
});

describe('speech rendering', () => {
  it('says times the way a person does', () => {
    expect(spokenTime('19:30')).toBe('seven thirty');
    expect(spokenTime('20:00')).toBe('eight o\'clock');
    expect(spokenTime('18:05')).toBe('six oh five');
    expect(spokenTime('12:45')).toBe('twelve forty five');
    expect(spokenTime('21:15')).toBe('nine fifteen');
    expect(spokenTime('00:30')).toBe('twelve thirty');
  });

  it('says dates relatively where that is natural', () => {
    expect(spokenDate('2026-06-15', '2026-06-15', LDN)).toBe('today');
    expect(spokenDate('2026-06-16', '2026-06-15', LDN)).toBe('tomorrow');
    expect(spokenDate('2026-06-19', '2026-06-15', LDN)).toBe('Friday the nineteenth');
    expect(spokenDate('2026-07-03', '2026-06-15', LDN)).toBe('Friday the third of July');
  });
});
