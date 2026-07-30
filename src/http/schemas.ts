import { z } from 'zod';
import { ACCESSIBILITY_REQUIREMENTS } from '../domain/accessibility.js';
import { SEATING_PREFERENCES } from '../domain/preferences.js';
import { NOISE_LEVELS, SEAT_TYPES, ZONES } from '../domain/attributes.js';

/**
 * Request and response schemas for every route.
 *
 * Single source of truth: Fastify validates against these, and
 * scripts/generate-openapi.ts converts the same objects into the published
 * spec. A schema and its documentation cannot drift apart if there is only one
 * of them.
 */

// --- Primitives ------------------------------------------------------------

export const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD in the restaurant local calendar')
  .describe('Local calendar date in the restaurant timezone, YYYY-MM-DD');

export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm in the restaurant local time')
  .describe('Local wall-clock time in the restaurant timezone, 24 hour HH:mm');

export const PhoneSchema = z
  .string()
  .trim()
  .min(6)
  .max(24)
  .regex(/^\+?[0-9][0-9 ()\-.]*$/, 'Expected a phone number')
  .describe('Guest phone number, E.164 preferred');

export const AccessibilitySchema = z
  .array(z.enum(ACCESSIBILITY_REQUIREMENTS))
  .max(7)
  .default([])
  .describe('Hard requirements. A table failing any of these is never offered.');

export const PreferencesSchema = z
  .array(z.enum(SEATING_PREFERENCES))
  .max(8)
  .default([])
  .describe('Soft preferences. Ranked for, never required.');

export const PartySizeSchema = z.number().int().min(1).max(60);

// --- Envelope --------------------------------------------------------------

/**
 * Every response, success or failure, carries `speech_hint`: one plain
 * sentence the agent reads aloud verbatim. It exists so the model never has to
 * render structured data into words itself — a model that paraphrases "19:45"
 * as "quarter to eight" and is heard as "eight" has made a wrong booking.
 */
export const SpeechHintSchema = z
  .string()
  .describe('A short plain sentence for the agent to read aloud, as written.');

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  speech_hint: SpeechHintSchema,
});

// --- Shared shapes ---------------------------------------------------------

export const TableOfferSchema = z.object({
  table_ids: z.array(z.uuid()),
  table_labels: z.array(z.string()),
  is_combination: z.boolean(),
  zone: z.enum(ZONES),
  seats: z.number().int(),
  matched_preferences: z.array(z.enum(SEATING_PREFERENCES)),
  unmatched_preferences: z.array(z.enum(SEATING_PREFERENCES)),
});

export const SlotOfferSchema = z.object({
  starts_at: z.iso.datetime().describe('UTC instant, ISO-8601'),
  ends_at: z.iso.datetime().describe('UTC instant, ISO-8601'),
  local_date: LocalDateSchema,
  local_time: LocalTimeSchema,
  spoken_time: z.string().describe("How to say it: 'seven thirty'"),
  service_period: z.string(),
  turn_time_minutes: z.number().int(),
  delta_minutes: z.number().int().describe('Signed minutes from the requested time'),
  table: TableOfferSchema,
});

// --- Voice: check-availability --------------------------------------------

export const CheckAvailabilityRequest = z.object({
  call_id: z.string().min(1).max(128),
  party_size: PartySizeSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema,
  accessibility: AccessibilitySchema,
  seating_preferences: PreferencesSchema,
  flexibility_minutes: z.number().int().min(0).max(240).optional(),
});

export const CheckAvailabilityResponse = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  speech_hint: SpeechHintSchema,
  reason: z.string().nullable(),
  large_party: z.boolean().describe('At or over the restaurant large party threshold'),
  turn_time_minutes: z.number().int(),
  offer: SlotOfferSchema.nullable(),
  alternatives: z.array(SlotOfferSchema),
  next_dates: z.array(SlotOfferSchema),
  hold: z
    .object({
      held: z.boolean(),
      expires_at: z.iso.datetime().nullable(),
      table_ids: z.array(z.uuid()),
    })
    .describe('A short Redis hold so a second caller is not offered the same table'),
});

// --- Voice: create-booking -------------------------------------------------

export const CreateBookingRequest = z.object({
  call_id: z.string().min(1).max(128),
  party_size: PartySizeSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema,
  guest_name: z.string().trim().min(1).max(120),
  phone: PhoneSchema,
  accessibility: AccessibilitySchema,
  seating_preferences: PreferencesSchema,
  allergies_verbatim: z
    .string()
    .max(1000)
    .optional()
    .describe('Stored exactly as the guest said it. Never summarised: allergy information is safety critical.'),
  occasion: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  table_ids: z
    .array(z.uuid())
    .max(3)
    .optional()
    .describe('Tables from a preceding check-availability, honoured if still free'),
});

export const BookingResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  reservation: z.object({
    id: z.uuid(),
    reference: z.string().describe('Six character reference for the guest'),
    status: z.string(),
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime(),
    local_date: LocalDateSchema,
    local_time: LocalTimeSchema,
    party_size: z.number().int(),
    table_labels: z.array(z.string()),
  }),
  idempotent_replay: z.boolean().describe('True when a repeated Idempotency-Key returned the original'),
});

// --- Voice: lookup / modify / cancel ---------------------------------------

export const LookupBookingRequest = z.object({
  call_id: z.string().min(1).max(128),
  phone: PhoneSchema.optional(),
  reservation_id: z.uuid().optional(),
}).refine((v) => Boolean(v.phone ?? v.reservation_id), {
  message: 'Provide phone or reservation_id',
});

export const LookupBookingResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  bookings: z.array(
    z.object({
      id: z.uuid(),
      reference: z.string(),
      status: z.string(),
      starts_at: z.iso.datetime(),
      local_date: LocalDateSchema,
      local_time: LocalTimeSchema,
      spoken_when: z.string(),
      party_size: z.number().int(),
      table_labels: z.array(z.string()),
    }),
  ),
});

export const ModifyBookingRequest = z.object({
  call_id: z.string().min(1).max(128),
  /**
   * Either identifier works. A caller on the phone does not know their
   * reservation id, and a voice flow with no lookup step has only the number
   * they are ringing from, so `phone` resolves to their next upcoming booking.
   */
  reservation_id: z.uuid().optional(),
  phone: PhoneSchema.optional(),
  date: LocalDateSchema.optional(),
  time: LocalTimeSchema.optional(),
  party_size: PartySizeSchema.optional(),
  accessibility: z.array(z.enum(ACCESSIBILITY_REQUIREMENTS)).max(7).optional(),
  seating_preferences: z.array(z.enum(SEATING_PREFERENCES)).max(8).optional(),
  notes: z.string().max(2000).optional(),
}).refine((v) => Boolean(v.reservation_id ?? v.phone), {
  message: 'Provide reservation_id or phone',
});

export const CancelBookingRequest = z.object({
  call_id: z.string().min(1).max(128),
  reservation_id: z.uuid().optional(),
  phone: PhoneSchema.optional(),
  reason: z.string().max(500).optional(),
}).refine((v) => Boolean(v.phone ?? v.reservation_id), {
  message: 'Provide phone or reservation_id',
});

export const CancelBookingResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  cancelled: z.object({
    id: z.uuid(),
    reference: z.string(),
    starts_at: z.iso.datetime(),
    local_date: LocalDateSchema,
    local_time: LocalTimeSchema,
  }),
});

// --- Voice: search-knowledge ----------------------------------------------

export const SearchKnowledgeRequest = z.object({
  call_id: z.string().min(1).max(128),
  query: z.string().trim().min(1).max(500),
  top_k: z.number().int().min(1).max(8).default(4),
});

export const SearchKnowledgeResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  results: z.array(
    z.object({
      title: z.string(),
      source: z.enum(['policy', 'menu', 'faq', 'layout', 'hours']),
      content: z.string(),
      score: z.number(),
    }),
  ),
});

// --- Voice: waitlist / enquiry / call events -------------------------------

export const JoinWaitlistRequest = z.object({
  call_id: z.string().min(1).max(128),
  guest_name: z.string().trim().min(1).max(120),
  phone: PhoneSchema,
  date: LocalDateSchema,
  window_start: LocalTimeSchema,
  window_end: LocalTimeSchema,
  party_size: PartySizeSchema,
  accessibility: AccessibilitySchema,
  seating_preferences: PreferencesSchema,
});

export const JoinWaitlistResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  waitlist_entry: z.object({
    id: z.uuid(),
    date: LocalDateSchema,
    window_start: z.iso.datetime(),
    window_end: z.iso.datetime(),
    party_size: z.number().int(),
    status: z.string(),
  }),
});

export const CreateEnquiryRequest = z.object({
  call_id: z.string().min(1).max(128),
  category: z
    .enum(['private_hire', 'large_party', 'lost_property', 'feedback', 'press', 'supplier', 'other'])
    .default('other'),
  guest_name: z.string().trim().min(1).max(120),
  phone: PhoneSchema,
  message: z.string().trim().min(1).max(4000),
});

export const CreateEnquiryResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  enquiry: z.object({ id: z.uuid(), category: z.string(), status: z.string() }),
});

export const CallEventRequest = z.object({
  call_id: z.string().min(1).max(128),
  event: z.enum(['call_started', 'call_ended', 'transcript', 'recording']),
  caller_number: PhoneSchema.optional(),
  started_at: z.iso.datetime().optional(),
  ended_at: z.iso.datetime().optional(),
  outcome: z.string().max(200).optional(),
  recording_url: z.url().optional(),
  transcript: z
    .array(z.object({ role: z.enum(['agent', 'caller', 'system']), text: z.string(), at: z.string().optional() }))
    .optional(),
});

export const CallEventResponse = z.object({
  ok: z.literal(true),
  speech_hint: SpeechHintSchema,
  call_id: z.string(),
});

// --- Admin -----------------------------------------------------------------

export const TableAttributesInput = z.object({
  zone: z.enum(ZONES),
  seat_type: z.enum(SEAT_TYPES),
  is_wheelchair_accessible: z.boolean().default(false),
  has_wheelchair_clearance: z.boolean().default(false),
  near_window: z.boolean().default(false),
  near_entrance: z.boolean().default(false),
  near_toilets: z.boolean().default(false),
  near_kitchen: z.boolean().default(false),
  near_speakers: z.boolean().default(false),
  noise_level: z.enum(NOISE_LEVELS).default('normal'),
  is_combinable: z.boolean().default(false),
  combines_with: z.array(z.uuid()).default([]),
});

export const TurnTimesSchema = z
  .record(z.string(), z.number().int().min(15).max(600))
  .describe('Minutes keyed by party size, plus "default". Lookup brackets downwards.');

export const RestaurantCreate = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().regex(/^[a-z0-9-]{2,64}$/),
  timezone: z.string().min(1).describe('IANA identifier, validated against Intl'),
  phone: PhoneSchema,
  large_party_threshold: z.number().int().min(2).max(60).default(8),
  default_turn_times: TurnTimesSchema,
  booking_window_days: z.number().int().min(1).max(365).default(90),
  cancellation_policy: z.string().max(2000).default(''),
  flexibility_minutes: z.number().int().min(0).max(240).default(60),
});

export const RestaurantUpdate = RestaurantCreate.partial().omit({ slug: true });

export const FloorCreate = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.number().int().min(-5).max(20),
  step_free_access: z.boolean().default(false),
});

/** Shared field set so PATCH can reuse it without unwrapping the refinement. */
export const TableFields = z.object({
  floor_id: z.uuid(),
  label: z.string().trim().min(1).max(40),
  min_covers: z.number().int().min(1).max(60),
  max_covers: z.number().int().min(1).max(60),
  shape: z.enum(['round', 'square', 'rectangle', 'oval']).default('rectangle'),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  attributes: TableAttributesInput,
  is_active: z.boolean().default(true),
});

export const TableCreate = TableFields.refine((v) => v.max_covers >= v.min_covers, {
  message: 'max_covers must be greater than or equal to min_covers',
  path: ['max_covers'],
});

export const ServicePeriodCreate = z.object({
  name: z.string().trim().min(1).max(80),
  days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start_time: LocalTimeSchema,
  end_time: LocalTimeSchema,
  slot_interval_minutes: z.number().int().min(5).max(120).default(15),
  last_seating_offset_minutes: z.number().int().min(-360).max(0).default(-60),
  turn_time_overrides: TurnTimesSchema.nullish(),
  is_active: z.boolean().default(true),
});

export const ClosureCreate = z.object({
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  reason: z.string().trim().min(1).max(200),
});

export const TableBlockCreate = z.object({
  table_id: z.uuid(),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  reason: z.string().trim().min(1).max(200),
});

/** The JSON the front-end floor plan editor posts. */
export const FloorImport = z.object({
  replace_existing: z
    .boolean()
    .default(false)
    .describe('Delete tables on this floor that the payload does not mention. Refused if any has a live booking.'),
  tables: z
    .array(
      z.object({
        /** Editor-local key so combines_with can reference tables in the same payload. */
        key: z.string().min(1).max(64),
        id: z.uuid().optional().describe('Set to update an existing table'),
        label: z.string().trim().min(1).max(40),
        min_covers: z.number().int().min(1).max(60),
        max_covers: z.number().int().min(1).max(60),
        shape: z.enum(['round', 'square', 'rectangle', 'oval']).default('rectangle'),
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        attributes: TableAttributesInput.omit({ combines_with: true }).extend({
          combines_with: z
            .array(z.string())
            .default([])
            .describe('Editor keys or existing table uuids'),
        }),
        is_active: z.boolean().default(true),
      }),
    )
    .max(500),
});

export const KnowledgeDocumentCreate = z.object({
  source: z.enum(['policy', 'menu', 'faq', 'layout']),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(200_000),
});

export const AdminLoginRequest = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});

export const ReservationListQuery = z.object({
  from: LocalDateSchema.optional(),
  to: LocalDateSchema.optional(),
  status: z.enum(['held', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']).optional(),
  phone: PhoneSchema.optional(),
  source: z.enum(['voice', 'web', 'walk_in']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

// --- Public widget ---------------------------------------------------------

export const PublicAvailabilityRequest = z.object({
  party_size: PartySizeSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema,
  accessibility: AccessibilitySchema,
  seating_preferences: PreferencesSchema,
  flexibility_minutes: z.number().int().min(0).max(240).optional(),
});

export const PublicBookingRequest = z.object({
  party_size: PartySizeSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema,
  guest_name: z.string().trim().min(1).max(120),
  phone: PhoneSchema,
  accessibility: AccessibilitySchema,
  seating_preferences: PreferencesSchema,
  allergies_verbatim: z.string().max(1000).optional(),
  occasion: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export type CheckAvailabilityBody = z.infer<typeof CheckAvailabilityRequest>;
export type CreateBookingBody = z.infer<typeof CreateBookingRequest>;
export type ModifyBookingBody = z.infer<typeof ModifyBookingRequest>;
export type CancelBookingBody = z.infer<typeof CancelBookingRequest>;
export type FloorImportBody = z.infer<typeof FloorImport>;
