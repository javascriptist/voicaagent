import { describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_REQUIREMENTS,
  satisfiesAllRequirements,
  satisfiesRequirement,
  firstUnmetRequirement,
} from '../../src/domain/accessibility.js';
import { attrs } from '../fixtures/restaurant.js';

const GROUND = { level: 0, stepFreeAccess: false };
const UPSTAIRS = { level: 1, stepFreeAccess: false };
const UPSTAIRS_LIFT = { level: 1, stepFreeAccess: true };
const BASEMENT = { level: -1, stepFreeAccess: false };

describe('step_free', () => {
  it('passes on the ground floor even without a recorded lift', () => {
    expect(satisfiesRequirement('step_free', attrs(), GROUND)).toBe(true);
  });

  it('fails above ground without a lift or ramp', () => {
    expect(satisfiesRequirement('step_free', attrs(), UPSTAIRS)).toBe(false);
  });

  it('fails in the basement without a lift', () => {
    expect(satisfiesRequirement('step_free', attrs(), BASEMENT)).toBe(false);
  });

  it('passes above ground when the floor records step-free access', () => {
    expect(satisfiesRequirement('step_free', attrs(), UPSTAIRS_LIFT)).toBe(true);
  });
});

describe('wheelchair_space', () => {
  it('requires both accessibility and clearance', () => {
    const reachableButBoxedIn = attrs({
      is_wheelchair_accessible: true,
      has_wheelchair_clearance: false,
    });
    const clearanceButUnreachable = attrs({
      is_wheelchair_accessible: false,
      has_wheelchair_clearance: true,
    });
    const good = attrs({ is_wheelchair_accessible: true, has_wheelchair_clearance: true });

    expect(satisfiesRequirement('wheelchair_space', reachableButBoxedIn, GROUND)).toBe(false);
    expect(satisfiesRequirement('wheelchair_space', clearanceButUnreachable, GROUND)).toBe(false);
    expect(satisfiesRequirement('wheelchair_space', good, GROUND)).toBe(true);
  });

  it('implies step-free: a perfect table up a staircase is not usable', () => {
    const good = attrs({ is_wheelchair_accessible: true, has_wheelchair_clearance: true });
    expect(satisfiesRequirement('wheelchair_space', good, UPSTAIRS)).toBe(false);
    expect(satisfiesRequirement('wheelchair_space', good, UPSTAIRS_LIFT)).toBe(true);
  });
});

describe('transfer_seat', () => {
  it('rejects fixed seating', () => {
    const base = { is_wheelchair_accessible: true, has_wheelchair_clearance: true };
    expect(satisfiesRequirement('transfer_seat', attrs({ ...base, seat_type: 'booth' }), GROUND)).toBe(false);
    expect(satisfiesRequirement('transfer_seat', attrs({ ...base, seat_type: 'banquette' }), GROUND)).toBe(false);
    expect(satisfiesRequirement('transfer_seat', attrs({ ...base, seat_type: 'high_stool' }), GROUND)).toBe(false);
    expect(satisfiesRequirement('transfer_seat', attrs({ ...base, seat_type: 'chair' }), GROUND)).toBe(true);
  });
});

describe('low_noise', () => {
  it('needs a quiet table that is not next to a speaker', () => {
    expect(satisfiesRequirement('low_noise', attrs({ noise_level: 'quiet' }), GROUND)).toBe(true);
    expect(
      satisfiesRequirement('low_noise', attrs({ noise_level: 'quiet', near_speakers: true }), GROUND),
    ).toBe(false);
    expect(satisfiesRequirement('low_noise', attrs({ noise_level: 'normal' }), GROUND)).toBe(false);
  });
});

describe('defaults never pass by accident', () => {
  it('a table with no attributes recorded fails every table-level requirement', () => {
    const bare = attrs();
    const tableLevel = ACCESSIBILITY_REQUIREMENTS.filter((r) => r !== 'step_free');

    // step_free is the one exception, and only on the ground floor, because
    // "no steps at street level" is a fact about the building we do know.
    for (const requirement of tableLevel) {
      expect(satisfiesRequirement(requirement, bare, GROUND)).toBe(false);
    }
  });
});

describe('combining requirements', () => {
  it('needs every requirement, not the best one', () => {
    const quietUpstairs = attrs({
      noise_level: 'quiet',
      is_wheelchair_accessible: true,
      has_wheelchair_clearance: true,
    });
    expect(satisfiesAllRequirements(['low_noise'], quietUpstairs, UPSTAIRS)).toBe(true);
    expect(satisfiesAllRequirements(['low_noise', 'step_free'], quietUpstairs, UPSTAIRS)).toBe(false);
    expect(firstUnmetRequirement(['low_noise', 'step_free'], quietUpstairs, UPSTAIRS)).toBe('step_free');
  });

  it('an empty requirement list passes everything', () => {
    expect(satisfiesAllRequirements([], attrs(), UPSTAIRS)).toBe(true);
  });
});
