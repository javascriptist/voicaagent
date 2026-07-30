import { z } from 'zod';

/**
 * Table attributes.
 *
 * These live in a jsonb column because the set grows every time a restaurant
 * describes its room differently, but they are not free-form: this schema is
 * the contract, and the admin API validates against it on every write. The
 * availability engine may therefore treat every key as present and typed.
 */

export const ZONES = ['main', 'terrace', 'bar', 'private', 'mezzanine'] as const;
export const SEAT_TYPES = ['chair', 'banquette', 'booth', 'high_stool'] as const;
export const NOISE_LEVELS = ['quiet', 'normal', 'loud'] as const;

export type Zone = (typeof ZONES)[number];
export type SeatType = (typeof SEAT_TYPES)[number];
export type NoiseLevel = (typeof NOISE_LEVELS)[number];

export const TableAttributesSchema = z.object({
  zone: z.enum(ZONES),
  seat_type: z.enum(SEAT_TYPES),

  /// The table is usable by a wheelchair user: reachable, right height.
  is_wheelchair_accessible: z.boolean().default(false),
  /// There is physical room for a wheelchair *at* the table, i.e. a seat can be
  /// removed. Distinct from the above: a table can be reachable but boxed in.
  has_wheelchair_clearance: z.boolean().default(false),

  near_window: z.boolean().default(false),
  near_entrance: z.boolean().default(false),
  near_toilets: z.boolean().default(false),
  near_kitchen: z.boolean().default(false),
  near_speakers: z.boolean().default(false),

  noise_level: z.enum(NOISE_LEVELS).default('normal'),

  is_combinable: z.boolean().default(false),
  /// Table ids this table can be pushed together with. Treated as an
  /// undirected edge even if only one side declares it, see combinations.ts.
  combines_with: z.array(z.uuid()).default([]),
});

export type TableAttributes = z.infer<typeof TableAttributesSchema>;

/**
 * Attributes as they arrive from the layout editor, where table ids may not
 * exist yet. Same shape but combines_with holds editor-local keys.
 */
export const TableAttributesImportSchema = TableAttributesSchema.extend({
  combines_with: z.array(z.string()).default([]),
});

/** Defaults for a table the admin created without saying much about it. */
export function defaultAttributes(zone: Zone = 'main'): TableAttributes {
  return TableAttributesSchema.parse({ zone, seat_type: 'chair' });
}

/**
 * Parse a jsonb value into typed attributes, falling back to defaults for
 * anything missing. Used on the read path, where refusing to serve a booking
 * because one table has a malformed attribute blob would be the wrong trade.
 */
export function parseAttributes(value: unknown): TableAttributes {
  const parsed = TableAttributesSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const partial = (value ?? {}) as Record<string, unknown>;
  return TableAttributesSchema.parse({
    ...partial,
    zone: ZONES.includes(partial.zone as Zone) ? partial.zone : 'main',
    seat_type: SEAT_TYPES.includes(partial.seat_type as SeatType) ? partial.seat_type : 'chair',
    noise_level: NOISE_LEVELS.includes(partial.noise_level as NoiseLevel)
      ? partial.noise_level
      : 'normal',
    combines_with: Array.isArray(partial.combines_with) ? partial.combines_with : [],
  });
}
