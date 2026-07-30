import { z } from 'zod';
import type { TableAttributes } from './attributes.js';

/**
 * Accessibility requirements.
 *
 * These are HARD filters. A table that fails one is never returned, never
 * scored, never offered as an alternative — not when the restaurant is empty,
 * not when it is the last table in the building. Getting this wrong means a
 * wheelchair user arrives to a table they cannot use, which is worse than
 * being told there is no availability.
 *
 * Everything here is a total function of (table attributes, floor). No
 * defaults that quietly pass: if we do not positively know the table satisfies
 * the requirement, it fails.
 */

export const ACCESSIBILITY_REQUIREMENTS = [
  /** Guest cannot use stairs. */
  'step_free',
  /** Wheelchair user stays in their chair at the table. */
  'wheelchair_space',
  /** Wheelchair user transfers to a dining chair, so the seat must be movable. */
  'transfer_seat',
  /** Assistance dog needs floor space beside the guest. */
  'assistance_dog',
  /** Hearing aid or sensory need: quiet, away from speakers. */
  'low_noise',
  /** Limited mobility: minimise distance from the door. */
  'near_entrance',
  /** Medical need for quick access to toilets. */
  'near_toilets',
] as const;

export type AccessibilityRequirement = (typeof ACCESSIBILITY_REQUIREMENTS)[number];

export const AccessibilityRequirementSchema = z.enum(ACCESSIBILITY_REQUIREMENTS);

/** The floor facts the predicates need. Keeps this module free of Prisma types. */
export interface FloorFacts {
  level: number;
  stepFreeAccess: boolean;
}

type Predicate = (attrs: TableAttributes, floor: FloorFacts) => boolean;

const PREDICATES: Record<AccessibilityRequirement, Predicate> = {
  // Ground level always qualifies; above or below ground needs a lift or ramp
  // recorded on the floor.
  step_free: (_attrs, floor) => floor.level === 0 || floor.stepFreeAccess === true,

  // Both flags required. is_wheelchair_accessible alone means "a wheelchair
  // user can get to it"; without clearance there is nowhere to put the chair.
  // The guest must also be able to reach the table, so step-free is implied.
  wheelchair_space: (attrs, floor) =>
    attrs.is_wheelchair_accessible === true &&
    attrs.has_wheelchair_clearance === true &&
    (floor.level === 0 || floor.stepFreeAccess === true),

  // Transferring out of a wheelchair needs a chair that moves out of the way.
  // Booths and banquettes are fixed; high stools are the wrong height.
  transfer_seat: (attrs, floor) =>
    attrs.seat_type === 'chair' &&
    attrs.is_wheelchair_accessible === true &&
    (floor.level === 0 || floor.stepFreeAccess === true),

  // A dog needs the same floor area a wheelchair would, and stairs are a
  // problem for many assistance dogs' handlers.
  assistance_dog: (attrs, floor) =>
    attrs.has_wheelchair_clearance === true &&
    (floor.level === 0 || floor.stepFreeAccess === true),

  low_noise: (attrs) => attrs.noise_level === 'quiet' && attrs.near_speakers === false,

  near_entrance: (attrs, floor) =>
    attrs.near_entrance === true && (floor.level === 0 || floor.stepFreeAccess === true),

  near_toilets: (attrs) => attrs.near_toilets === true,
};

/** Does this table satisfy one requirement? */
export function satisfiesRequirement(
  requirement: AccessibilityRequirement,
  attrs: TableAttributes,
  floor: FloorFacts,
): boolean {
  return PREDICATES[requirement](attrs, floor);
}

/** Does this table satisfy every requirement? Empty list trivially passes. */
export function satisfiesAllRequirements(
  requirements: readonly AccessibilityRequirement[],
  attrs: TableAttributes,
  floor: FloorFacts,
): boolean {
  return requirements.every((r) => satisfiesRequirement(r, attrs, floor));
}

/** The first requirement this table fails, for diagnostics and speech hints. */
export function firstUnmetRequirement(
  requirements: readonly AccessibilityRequirement[],
  attrs: TableAttributes,
  floor: FloorFacts,
): AccessibilityRequirement | null {
  return requirements.find((r) => !satisfiesRequirement(r, attrs, floor)) ?? null;
}

/** Plain English, for reading aloud. */
export const REQUIREMENT_PHRASES: Record<AccessibilityRequirement, string> = {
  step_free: 'step-free access',
  wheelchair_space: 'space for a wheelchair at the table',
  transfer_seat: 'a movable chair to transfer into',
  assistance_dog: 'room for an assistance dog',
  low_noise: 'a quieter table',
  near_entrance: 'a table near the entrance',
  near_toilets: 'a table near the toilets',
};

/**
 * A table counts as "reserved for guests who need it" when it carries
 * accessibility affordances that are scarce. Used by the scorer to keep these
 * tables free, see score.ts.
 */
export function isAccessibilityAsset(attrs: TableAttributes): boolean {
  return attrs.is_wheelchair_accessible === true || attrs.has_wheelchair_clearance === true;
}
