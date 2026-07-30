import { z } from 'zod';
import type { TableAttributes } from './attributes.js';

/**
 * Seating preferences.
 *
 * SOFT. These move a table up the ranking (+10 each, see score.ts) and are
 * never a reason to return nothing. "I'd like a booth" must not turn into "we
 * have no tables" — it turns into a non-booth table and a speech hint that
 * says so.
 */

export const SEATING_PREFERENCES = [
  'window',
  'booth',
  'banquette',
  'high_stool',
  'quiet',
  'lively',
  'terrace',
  'bar',
  'private',
  'main',
  'mezzanine',
  'away_from_kitchen',
  'away_from_toilets',
  'away_from_entrance',
  'away_from_speakers',
] as const;

export type SeatingPreference = (typeof SEATING_PREFERENCES)[number];

export const SeatingPreferenceSchema = z.enum(SEATING_PREFERENCES);

const PREDICATES: Record<SeatingPreference, (a: TableAttributes) => boolean> = {
  window: (a) => a.near_window,
  booth: (a) => a.seat_type === 'booth',
  banquette: (a) => a.seat_type === 'banquette',
  high_stool: (a) => a.seat_type === 'high_stool',
  quiet: (a) => a.noise_level === 'quiet',
  lively: (a) => a.noise_level === 'loud',
  terrace: (a) => a.zone === 'terrace',
  bar: (a) => a.zone === 'bar',
  private: (a) => a.zone === 'private',
  main: (a) => a.zone === 'main',
  mezzanine: (a) => a.zone === 'mezzanine',
  away_from_kitchen: (a) => !a.near_kitchen,
  away_from_toilets: (a) => !a.near_toilets,
  away_from_entrance: (a) => !a.near_entrance,
  away_from_speakers: (a) => !a.near_speakers,
};

export function matchesPreference(pref: SeatingPreference, attrs: TableAttributes): boolean {
  return PREDICATES[pref](attrs);
}

/**
 * Which of the requested preferences this set of tables satisfies.
 *
 * For a combination every table must match. A party of nine asking for booths
 * and getting one booth plus one high-stool table has not got what they asked
 * for, and half-crediting it would rank that above two plain tables together.
 */
export function matchedPreferences(
  prefs: readonly SeatingPreference[],
  tables: readonly TableAttributes[],
): SeatingPreference[] {
  if (tables.length === 0) return [];
  return prefs.filter((p) => tables.every((t) => matchesPreference(p, t)));
}

/** Plain English, for reading aloud. */
export const PREFERENCE_PHRASES: Record<SeatingPreference, string> = {
  window: 'a table by the window',
  booth: 'a booth',
  banquette: 'a banquette',
  high_stool: 'high stools',
  quiet: 'a quiet table',
  lively: 'a table in the busier part of the room',
  terrace: 'a table on the terrace',
  bar: 'a table at the bar',
  private: 'the private room',
  main: 'a table in the main room',
  mezzanine: 'a table on the mezzanine',
  away_from_kitchen: 'a table away from the kitchen',
  away_from_toilets: 'a table away from the toilets',
  away_from_entrance: 'a table away from the door',
  away_from_speakers: 'a table away from the speakers',
};
