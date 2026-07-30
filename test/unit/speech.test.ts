import { describe, expect, it } from 'vitest';
import { findAvailability } from '../../src/availability/engine.js';
import type { AvailabilityResult } from '../../src/availability/types.js';
import { ACCESSIBILITY_REQUIREMENTS, REQUIREMENT_PHRASES } from '../../src/domain/accessibility.js';
import { PREFERENCE_PHRASES, SEATING_PREFERENCES } from '../../src/domain/preferences.js';
import { AppError } from '../../src/lib/errors.js';
import {
  SPEECH_SAFE,
  describeSpeechViolation,
  isSpeechSafe,
  makeSpeakable,
  numberToWords,
  peopleWords,
} from '../../src/speech/index.js';
import {
  acknowledgementSpeech,
  availabilitySpeech,
  bookingCancelledSpeech,
  bookingConfirmedSpeech,
  bookingModifiedSpeech,
  enquirySpeech,
  knowledgeSpeech,
  lookupSpeech,
  unavailableSpeech,
  waitlistSpeech,
} from '../../src/speech/hints.js';
import { spokenDate, spokenTime } from '../../src/time/zone.js';
import {
  DINNER,
  GROUND_FLOOR,
  LONDON,
  at,
  makeSnapshot,
  makeTables,
  reservation,
} from '../fixtures/restaurant.js';

/**
 * speech_hint goes straight into a Vonage AI Studio Speak node.
 *
 * There is no model in between to tidy it up, so anything unspeakable that
 * reaches this field is read to a caller exactly as written: "19:30" becomes
 * "one nine three zero", a uuid becomes a minute of letters. These tests are
 * the gate.
 */

const TODAY = '2026-06-10';
const NOW = at('2026-06-10', '09:00');

function expectSpeakable(hint: string): void {
  const violation = describeSpeechViolation(hint);
  expect(violation, `${violation} in: ${JSON.stringify(hint)}`).toBeNull();
}

describe('the guard itself', () => {
  it('accepts an ordinary spoken sentence', () => {
    expect(isSpeechSafe("That's booked, seven thirty on Friday the nineteenth.")).toBe(true);
    expect(isSpeechSafe('Shall I try an hour either side?')).toBe(true);
    expect(isSpeechSafe('We have step-free access to the ground floor.')).toBe(true);
  });

  it('rejects digits', () => {
    expect(isSpeechSafe('Table 12 at 19:30')).toBe(false);
    expect(describeSpeechViolation('Booked for 4 people')).toMatch(/digit/);
  });

  it('rejects the things a template leaks', () => {
    expect(describeSpeechViolation('Seven thirty: table twelve')).toMatch(/colon/);
    expect(describeSpeechViolation('- seven thirty\n- eight')).toMatch(/newline|digit/);
    expect(describeSpeechViolation('**Booked**')).toMatch(/markdown/);
    expect(describeSpeechViolation('Booked — seven thirty')).toMatch(/dash/);
    expect(describeSpeechViolation('Booked (table twelve)')).toMatch(/bracket/);
    expect(describeSpeechViolation('a/b')).toMatch(/slash/);
  });

  it('rejects an empty hint, which a Speak node cannot read', () => {
    expect(describeSpeechViolation('')).toBe('empty');
  });

  it('accepts letters outside ASCII, because guests have names', () => {
    // The rule is "no digits, no punctuation beyond the allowed set". A guest
    // called José has a name made of letters; refusing to say it would be a
    // worse bug than the one this guard exists to catch.
    expect(isSpeechSafe("That's booked, José.")).toBe(true);
    expect(isSpeechSafe('Booked for Müller.')).toBe(true);
  });
});

describe('numbers become words', () => {
  it('covers every party size the schema allows', () => {
    for (let n = 1; n <= 60; n++) {
      expectSpeakable(numberToWords(n));
      expectSpeakable(peopleWords(n));
    }
  });

  it('says the ones that matter correctly', () => {
    expect(numberToWords(1)).toBe('one');
    expect(numberToWords(9)).toBe('nine');
    expect(numberToWords(12)).toBe('twelve');
    expect(numberToWords(21)).toBe('twenty-one');
    expect(numberToWords(40)).toBe('forty');
    expect(numberToWords(90)).toBe('ninety');
    expect(peopleWords(1)).toBe('one person');
    expect(peopleWords(2)).toBe('two people');
  });

  it('never returns digits, even for nonsense input', () => {
    for (const n of [0, 100, 365, 999, 1000, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectSpeakable(numberToWords(n));
    }
  });
});

describe('makeSpeakable cleans text we did not write', () => {
  it('turns digits in a guest note into words', () => {
    expect(makeSpeakable('table 4 please')).toBe('table four please');
  });

  it('survives names, allergies and typography', () => {
    const inputs = [
      "O'Brien",
      'José García',
      'Anne-Marie',
      'severe nut allergy (anaphylaxis)',
      'dairy — and shellfish',
      'party of 12, booth if possible',
      '  spaced   out  ',
      'emoji 🎉 party',
      '<script>alert(1)</script>',
    ];
    for (const input of inputs) {
      const cleaned = makeSpeakable(input);
      if (cleaned.length > 0) expectSpeakable(cleaned);
    }
  });

  it('keeps the apostrophe in a name', () => {
    expect(makeSpeakable("O'Brien")).toBe("O'Brien");
  });
});

describe('every phrase table is speakable', () => {
  it('accessibility phrases', () => {
    for (const requirement of ACCESSIBILITY_REQUIREMENTS) {
      expectSpeakable(REQUIREMENT_PHRASES[requirement]);
    }
  });

  it('seating preference phrases', () => {
    for (const preference of SEATING_PREFERENCES) {
      expectSpeakable(PREFERENCE_PHRASES[preference]);
    }
  });

  it('spoken times, for every slot in a day', () => {
    for (let minute = 0; minute < 1440; minute += 5) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      expectSpeakable(spokenTime(time));
    }
  });

  it('spoken dates, for a year ahead', () => {
    for (let day = 0; day < 366; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      expectSpeakable(spokenDate(date, TODAY, LONDON));
    }
  });
});

describe('every error speech hint is speakable', () => {
  it('covers every error code', () => {
    const codes = [
      'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict',
      'slot_taken', 'hold_expired', 'invalid_signature', 'stale_timestamp',
      'rate_limited', 'unavailable', 'internal',
    ] as const;
    for (const code of codes) {
      const error = new AppError(code, 'test');
      expectSpeakable(error.speechHint);
      expect(error.toResponse().speech_hint).toBe(error.speechHint);
      // And never a stack trace or an internal message.
      expect(error.toResponse()).not.toHaveProperty('stack');
      expect(error.toResponse()).not.toHaveProperty('message');
    }
  });
});

describe('every builder produces a speakable hint', () => {
  const dateTimes: Array<[string, string]> = [
    ['2026-06-10', '19:30'],
    ['2026-06-11', '12:00'],
    ['2026-06-19', '20:05'],
    ['2026-12-25', '18:45'],
    ['2026-03-29', '13:00'],
  ];

  it('bookingConfirmedSpeech across party sizes, names and allergies', () => {
    for (const [date, time] of dateTimes) {
      for (const partySize of [1, 2, 4, 9, 12, 40]) {
        for (const name of ['Sam', "O'Brien", 'José', '', 'Table 4 Guy']) {
          for (const allergies of [null, 'severe nut allergy', 'dairy — 2 in the party']) {
            expectSpeakable(
              bookingConfirmedSpeech({
                localDate: date,
                localTime: time,
                today: TODAY,
                zone: LONDON,
                partySize,
                guestName: name,
                allergies,
                largeParty: partySize >= 8,
              }),
            );
          }
        }
      }
    }
  });

  it('bookingModifiedSpeech and bookingCancelledSpeech', () => {
    for (const [date, time] of dateTimes) {
      expectSpeakable(
        bookingModifiedSpeech({ localDate: date, localTime: time, today: TODAY, zone: LONDON, partySize: 6 }),
      );
      expectSpeakable(
        bookingCancelledSpeech({ localDate: date, localTime: time, today: TODAY, zone: LONDON }),
      );
    }
  });

  it('lookupSpeech for none, one and many', () => {
    expectSpeakable(lookupSpeech([], TODAY, LONDON));
    expectSpeakable(
      lookupSpeech([{ localDate: '2026-06-19', localTime: '19:30', partySize: 2 }], TODAY, LONDON),
    );
    expectSpeakable(
      lookupSpeech(
        Array.from({ length: 7 }, () => ({ localDate: '2026-06-19', localTime: '19:30', partySize: 4 })),
        TODAY,
        LONDON,
      ),
    );
  });

  it('waitlistSpeech, enquirySpeech, knowledgeSpeech, acknowledgementSpeech', () => {
    expectSpeakable(
      waitlistSpeech({ localDate: '2026-06-19', today: TODAY, zone: LONDON, partySize: 11 }),
    );
    for (const name of ['Sam', "O'Brien", '', 'Guest 2']) expectSpeakable(enquirySpeech(name));
    expectSpeakable(knowledgeSpeech(false));
    for (const title of ['Opening hours', 'Accessibility and step-free access', 'Menu (v2)']) {
      expectSpeakable(knowledgeSpeech(true, title));
    }
    expectSpeakable(acknowledgementSpeech());
  });
});

describe('availability hints over real engine output', () => {
  function hintFor(result: AvailabilityResult): string {
    return availabilitySpeech(result, LONDON, TODAY);
  }

  it('is speakable for every reason the engine can return', () => {
    const oneTable = makeTables([{ label: 'ONLY', min: 1, max: 6 }], GROUND_FLOOR.id);
    const scenarios: Array<[string, AvailabilityResult]> = [];

    const base = {
      partySize: 2,
      accessibility: [] as never[],
      seatingPreferences: [] as never[],
      now: NOW,
    };

    // Available, plain.
    scenarios.push([
      'available',
      findAvailability(makeSnapshot(), { ...base, date: '2026-06-15', time: '19:30' }),
    ]);

    // Available with a matched preference.
    scenarios.push([
      'preference matched',
      findAvailability(
        makeSnapshot({
          tables: makeTables(
            [{ label: 'B1', min: 1, max: 4, attributes: { seat_type: 'booth', near_window: true } }],
            GROUND_FLOOR.id,
          ),
        }),
        { ...base, date: '2026-06-15', time: '19:30', seatingPreferences: ['booth', 'window'] },
      ),
    ]);

    // Available but a preference could not be met.
    scenarios.push([
      'preference unmatched',
      findAvailability(makeSnapshot(), {
        ...base,
        date: '2026-06-15',
        time: '19:30',
        seatingPreferences: ['booth'],
      }),
    ]);

    // Large party on a combination.
    const combo = makeTables(
      [
        { label: 'M1', min: 2, max: 4, attributes: { is_combinable: true } },
        { label: 'M2', min: 2, max: 6, attributes: { is_combinable: true } },
      ],
      GROUND_FLOOR.id,
    );
    combo[0]!.attributes.combines_with = [combo[1]!.id];
    combo[1]!.attributes.combines_with = [combo[0]!.id];
    scenarios.push([
      'large party combination',
      findAvailability(makeSnapshot({ tables: combo }), {
        ...base,
        partySize: 9,
        date: '2026-06-15',
        time: '19:30',
      }),
    ]);

    // Fully booked, with alternatives.
    scenarios.push([
      'fully booked',
      findAvailability(
        makeSnapshot({
          tables: oneTable,
          occupancy: [reservation(oneTable[0]!.id, '2026-06-15', '19:30', 90)],
        }),
        { ...base, date: '2026-06-15', time: '19:30', flexibilityMinutes: 90 },
      ),
    ]);

    // Fully booked all evening, so next dates instead.
    scenarios.push([
      'next dates',
      findAvailability(
        makeSnapshot({
          tables: oneTable,
          occupancy: [reservation(oneTable[0]!.id, '2026-06-15', '17:00', 360)],
        }),
        { ...base, date: '2026-06-15', time: '19:30', flexibilityMinutes: 120 },
      ),
    ]);

    // Closed.
    scenarios.push([
      'closed',
      findAvailability(
        makeSnapshot({
          closures: [
            { startsAt: at('2026-06-15', '00:00'), endsAt: at('2026-06-16', '00:00'), reason: 'refit' },
          ],
        }),
        { ...base, date: '2026-06-15', time: '19:30' },
      ),
    ]);

    // Not a service time, in the past, outside window, party too large.
    scenarios.push([
      'not a service time',
      findAvailability(makeSnapshot(), { ...base, date: '2026-06-15', time: '09:00' }),
    ]);
    scenarios.push([
      'in the past',
      findAvailability(makeSnapshot(), {
        ...base,
        date: '2026-06-15',
        time: '19:30',
        now: at('2026-06-15', '20:00'),
      }),
    ]);
    scenarios.push([
      'outside window',
      findAvailability(makeSnapshot({ restaurant: { bookingWindowDays: 30 } }), {
        ...base,
        date: '2026-12-25',
        time: '19:30',
      }),
    ]);
    scenarios.push([
      'party too large',
      findAvailability(makeSnapshot(), { ...base, partySize: 50, date: '2026-06-15', time: '19:30' }),
    ]);

    // No accessible table.
    const accessibleRoom = makeTables(
      [
        {
          label: 'ACC',
          min: 1,
          max: 4,
          attributes: { is_wheelchair_accessible: true, has_wheelchair_clearance: true },
        },
        { label: 'P1', min: 1, max: 4 },
      ],
      GROUND_FLOOR.id,
    );
    scenarios.push([
      'no accessible table',
      findAvailability(
        makeSnapshot({
          tables: accessibleRoom,
          occupancy: [reservation(accessibleRoom[0]!.id, '2026-06-15', '17:00', 360)],
        }),
        { ...base, date: '2026-06-15', time: '19:30', accessibility: ['wheelchair_space'] },
      ),
    ]);

    // DST gap.
    scenarios.push([
      'nonexistent local time',
      findAvailability(
        makeSnapshot({ restaurant: { timezone: 'America/New_York' }, servicePeriods: [DINNER] }),
        { ...base, date: '2026-03-08', time: '02:30', now: at('2026-02-01', '09:00') },
      ),
    ]);

    const seenReasons = new Set<string>();
    for (const [label, result] of scenarios) {
      seenReasons.add(result.reason ?? 'available');
      const hint = hintFor(result);
      const violation = describeSpeechViolation(hint);
      expect(violation, `${label}: ${violation} in ${JSON.stringify(hint)}`).toBeNull();
      // Also check the dedicated unavailable builder directly.
      expectSpeakable(unavailableSpeech(result, LONDON, TODAY));
    }

    // Confirms the scenario list actually exercised the branches, rather than
    // ten variations of the same one.
    expect(seenReasons.size).toBeGreaterThanOrEqual(8);
  });

  it('says a time in words, never as digits', () => {
    const result = findAvailability(makeSnapshot(), {
      partySize: 2,
      date: '2026-06-15',
      time: '19:30',
      accessibility: [],
      seatingPreferences: [],
      now: NOW,
    });
    const hint = hintFor(result);
    expect(hint).toContain('Seven thirty');
    expect(hint).not.toContain('19:30');
    expect(SPEECH_SAFE.test(hint)).toBe(true);
  });
});
