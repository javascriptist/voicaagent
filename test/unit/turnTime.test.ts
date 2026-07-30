import { describe, expect, it } from 'vitest';
import { FALLBACK_TURN_TIME_MINUTES, resolveTurnTime } from '../../src/availability/turnTime.js';

const TIMES = { default: 90, '1': 60, '2': 90, '5': 120, '8': 150 };

describe('resolveTurnTime', () => {
  it('uses an exact match when the size is configured', () => {
    expect(resolveTurnTime(1, TIMES)).toBe(60);
    expect(resolveTurnTime(2, TIMES)).toBe(90);
    expect(resolveTurnTime(5, TIMES)).toBe(120);
    expect(resolveTurnTime(8, TIMES)).toBe(150);
  });

  it('brackets downwards for sizes in between', () => {
    // A party of 6 falls in the "5 or more" bracket, not the "8 or more" one.
    // Bracketing up would remove half an hour of inventory per table per
    // sitting for a size the restaurant never said needed it.
    expect(resolveTurnTime(3, TIMES)).toBe(90);
    expect(resolveTurnTime(4, TIMES)).toBe(90);
    expect(resolveTurnTime(6, TIMES)).toBe(120);
    expect(resolveTurnTime(7, TIMES)).toBe(120);
    expect(resolveTurnTime(20, TIMES)).toBe(150);
  });

  it('falls back to default when nothing smaller is configured', () => {
    expect(resolveTurnTime(4, { default: 75 })).toBe(75);
  });

  it('falls back to a constant when the map is unusable', () => {
    expect(resolveTurnTime(4, {})).toBe(FALLBACK_TURN_TIME_MINUTES);
    expect(resolveTurnTime(4, { default: 0 })).toBe(FALLBACK_TURN_TIME_MINUTES);
    expect(resolveTurnTime(4, null as never)).toBe(FALLBACK_TURN_TIME_MINUTES);
  });

  it('applies a size override to that bracket only', () => {
    // Lunch turns the two tops faster but leaves every other bracket alone.
    const lunch = { '2': 60 };
    expect(resolveTurnTime(2, TIMES, lunch)).toBe(60);
    expect(resolveTurnTime(5, TIMES, lunch)).toBe(120);
    expect(resolveTurnTime(3, TIMES, lunch)).toBe(60);
    expect(resolveTurnTime(1, TIMES, lunch)).toBe(60);
  });

  it('lets a period default replace the whole restaurant policy', () => {
    // "Lunch turns in an hour" has to mean that for a party of six as well,
    // otherwise the dinner brackets quietly reimpose two hours.
    expect(resolveTurnTime(2, TIMES, { default: 60 })).toBe(60);
    expect(resolveTurnTime(6, TIMES, { default: 60 })).toBe(60);
    expect(resolveTurnTime(20, TIMES, { default: 60 })).toBe(60);
  });

  it('layers period size keys back on top of a period default', () => {
    const lunch = { default: 60, '8': 120 };
    expect(resolveTurnTime(2, TIMES, lunch)).toBe(60);
    expect(resolveTurnTime(9, TIMES, lunch)).toBe(120);
  });

  it('survives numbers that arrived from jsonb as strings', () => {
    expect(resolveTurnTime(2, { '2': '105' } as never)).toBe(105);
    expect(resolveTurnTime(2, { '2': 'soon' } as never)).toBe(FALLBACK_TURN_TIME_MINUTES);
  });
});
