import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import * as S from '../src/http/schemas.js';

/**
 * OpenAPI 3.1 generated from the Zod schemas the routes actually validate
 * against.
 *
 * Generated, never hand written: a spec maintained separately from the
 * validators drifts within a week, and the first thing anyone notices is that
 * the voice platform is sending a field the server silently drops.
 */

const registry: Record<string, unknown> = {};

/** Convert a Zod schema and hoist it into components/schemas. */
function ref(name: string, schema: z.ZodType): { $ref: string } {
  registry[name] = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  return { $ref: `#/components/schemas/${name}` };
}

function json(schema: { $ref: string }) {
  return { content: { 'application/json': { schema } } };
}

const errorRef = ref('ErrorResponse', S.ErrorResponseSchema);

/** The failure responses every voice endpoint can return. */
const voiceErrors = {
  '400': { description: 'Validation failed, or a missing Idempotency-Key', ...json(errorRef) },
  '401': {
    description: 'Signature invalid, timestamp outside the window, or unknown restaurant',
    ...json(errorRef),
  },
  '404': { description: 'Not found', ...json(errorRef) },
  '409': { description: 'The table was taken, or no availability', ...json(errorRef) },
  '429': { description: 'Rate limited', ...json(errorRef) },
  '500': { description: 'Internal error. Never a stack trace.', ...json(errorRef) },
};

function voicePath(
  summary: string,
  description: string,
  request: { $ref: string },
  response: { $ref: string },
  extra: { idempotent?: boolean } = {},
) {
  return {
    post: {
      summary,
      description,
      tags: ['voice'],
      security: [{ vonageJwt: [] }, { hmacSignature: [] }],
      parameters: [
        {
          name: 'X-Restaurant',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description:
            'Restaurant slug or uuid. Sent as a header so the signing secret can be chosen without parsing untrusted JSON.',
        },
        ...(extra.idempotent
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: true,
                schema: { type: 'string', maxLength: 200 },
                description:
                  'Required on writes. Replaying the same key returns the original record instead of creating a second one.',
              },
            ]
          : []),
      ],
      requestBody: { required: true, ...json(request) },
      responses: {
        '200': { description: 'Success', ...json(response) },
        '201': { description: 'Created', ...json(response) },
        ...voiceErrors,
      },
    },
  };
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Voice AI restaurant reservations',
    version: '0.1.0',
    description: `
Backend for a Vonage AI Studio voice agent that answers a restaurant's phone.

**Latency.** AI Studio's Webhook node drops into its error branch at five
seconds. Every endpoint here targets a 500 ms p95 and is asserted in CI against
a 1500 ms ceiling. There is no synchronous model call anywhere in the
availability path.

**speech_hint.** Every response, success or failure, carries a single short
sentence written to be read aloud verbatim by a Speak node. No digits, no ids,
no markdown, no lists: "seven thirty", never "19:30". AI Studio pipes it
straight to text to speech with no model in between to rephrase it.

**Times.** All input and output wall-clock times are local to the restaurant's
IANA timezone. All instants are UTC ISO-8601. Daylight saving gaps are rejected
rather than silently shifted.
`.trim(),
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local' }],
  tags: [
    { name: 'voice', description: 'Tool endpoints called by Vonage AI Studio during a call' },
    { name: 'admin', description: 'Restaurant configuration, JWT authenticated' },
    { name: 'public', description: 'Web booking widget, unauthenticated' },
  ],
  paths: {
    '/v1/voice/check-availability': voicePath(
      'Check availability',
      'Runs the pure availability engine and takes a short Redis hold on whatever it offers. Read-only as far as Postgres is concerned.',
      ref('CheckAvailabilityRequest', S.CheckAvailabilityRequest),
      ref('CheckAvailabilityResponse', S.CheckAvailabilityResponse),
    ),
    '/v1/voice/create-booking': voicePath(
      'Create a booking',
      'Consumes the hold inside a Postgres transaction. A `SELECT ... FOR UPDATE` on the candidate tables serialises concurrent attempts; the exclusion constraint on (table_id, tstzrange) is what actually makes a double booking impossible.',
      ref('CreateBookingRequest', S.CreateBookingRequest),
      ref('BookingResponse', S.BookingResponse),
      { idempotent: true },
    ),
    '/v1/voice/lookup-booking': voicePath(
      'Look up a booking',
      'By phone number or reservation id. Scoped to the calling restaurant.',
      ref('LookupBookingRequest', S.LookupBookingRequest),
      ref('LookupBookingResponse', S.LookupBookingResponse),
    ),
    '/v1/voice/modify-booking': voicePath(
      'Modify a booking',
      "Re-runs availability ignoring the booking's own occupancy, so moving it half an hour is not blocked by itself.",
      ref('ModifyBookingRequest', S.ModifyBookingRequest),
      ref('BookingResponse', S.BookingResponse),
      { idempotent: true },
    ),
    '/v1/voice/cancel-booking': voicePath(
      'Cancel a booking',
      'Cancelling an already cancelled booking succeeds: the guest\'s intent is satisfied and the agent may retry.',
      ref('CancelBookingRequest', S.CancelBookingRequest),
      ref('CancelBookingResponse', S.CancelBookingResponse),
    ),
    '/v1/voice/search-knowledge': voicePath(
      'Search restaurant knowledge',
      'Vector search scoped to the restaurant, then a lexical rerank. Query embeddings are cached in Redis for a day, so the common questions cost no network round trip.',
      ref('SearchKnowledgeRequest', S.SearchKnowledgeRequest),
      ref('SearchKnowledgeResponse', S.SearchKnowledgeResponse),
    ),
    '/v1/voice/join-waitlist': voicePath(
      'Join the waitlist',
      'For when the requested date is full.',
      ref('JoinWaitlistRequest', S.JoinWaitlistRequest),
      ref('JoinWaitlistResponse', S.JoinWaitlistResponse),
      { idempotent: true },
    ),
    '/v1/voice/create-enquiry': voicePath(
      'Record an enquiry',
      'Anything the agent cannot handle: private hire, lost property, feedback.',
      ref('CreateEnquiryRequest', S.CreateEnquiryRequest),
      ref('CreateEnquiryResponse', S.CreateEnquiryResponse),
      { idempotent: true },
    ),
    '/v1/voice/call-events': voicePath(
      'Call telemetry',
      'Call started, ended, transcript and recording. Events arrive out of order and more than once, so this upserts and only ever fills fields in.',
      ref('CallEventRequest', S.CallEventRequest),
      ref('CallEventResponse', S.CallEventResponse),
    ),

    '/v1/public/{slug}': {
      get: {
        summary: 'Public restaurant details',
        tags: ['public'],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Restaurant details and service periods' } },
      },
    },
    '/v1/public/{slug}/availability': {
      post: {
        summary: 'Availability for the web widget',
        description:
          'Same engine as the phone, so web and voice cannot double book. Returns times only, never table ids.',
        tags: ['public'],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          ...json(ref('PublicAvailabilityRequest', S.PublicAvailabilityRequest)),
        },
        responses: { '200': { description: 'Availability' }, '429': { description: 'Rate limited' } },
      },
    },
    '/v1/public/{slug}/bookings': {
      post: {
        summary: 'Create a booking from the web widget',
        tags: ['public'],
        parameters: [
          { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, ...json(ref('PublicBookingRequest', S.PublicBookingRequest)) },
        responses: { '201': { description: 'Created' }, '409': { description: 'No longer available' } },
      },
    },

    '/v1/admin/login': {
      post: {
        summary: 'Exchange email and password for a restaurant-scoped JWT',
        tags: ['admin'],
        requestBody: { required: true, ...json(ref('AdminLoginRequest', S.AdminLoginRequest)) },
        responses: { '200': { description: 'Token' }, '401': { description: 'Invalid credentials' } },
      },
    },
    '/v1/admin/restaurant': {
      get: { summary: 'Read settings', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Settings' } } },
      patch: {
        summary: 'Update settings',
        description: 'Regenerates the derived knowledge documents and queues re-embedding.',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('RestaurantUpdate', S.RestaurantUpdate)) },
        responses: { '200': { description: 'Updated' } },
      },
    },
    '/v1/admin/floors': {
      get: { summary: 'List floors', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Floors' } } },
      post: {
        summary: 'Create a floor',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('FloorCreate', S.FloorCreate)) },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/admin/floors/{id}/import': {
      post: {
        summary: 'Import a floor plan from the layout editor',
        description:
          'One transaction, so a half-applied floor plan cannot exist. Refuses to delete a table that has an upcoming booking.',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, ...json(ref('FloorImport', S.FloorImport)) },
        responses: { '200': { description: 'Imported' }, '400': { description: 'Would delete a booked table' } },
      },
    },
    '/v1/admin/tables': {
      get: { summary: 'List tables', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Tables' } } },
      post: {
        summary: 'Create a table',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('TableCreate', S.TableCreate)) },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/admin/service-periods': {
      get: { summary: 'List service periods', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Periods' } } },
      post: {
        summary: 'Create a service period',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('ServicePeriodCreate', S.ServicePeriodCreate)) },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/admin/closures': {
      get: { summary: 'List closures', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Closures' } } },
      post: {
        summary: 'Create a closure',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('ClosureCreate', S.ClosureCreate)) },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/admin/table-blocks': {
      get: { summary: 'List table blocks', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Blocks' } } },
      post: {
        summary: 'Block a table',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('TableBlockCreate', S.TableBlockCreate)) },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/admin/knowledge': {
      get: { summary: 'List knowledge documents', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Documents' } } },
      post: {
        summary: 'Upload a knowledge document',
        description: 'Returns 202: chunking and embedding run as a background job.',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        requestBody: { required: true, ...json(ref('KnowledgeDocumentCreate', S.KnowledgeDocumentCreate)) },
        responses: { '202': { description: 'Accepted, embedding scheduled' } },
      },
    },
    '/v1/admin/reservations': {
      get: {
        summary: 'List reservations',
        tags: ['admin'],
        security: [{ adminJwt: [] }],
        responses: { '200': { description: 'Reservations' } },
      },
    },
    '/v1/admin/calls': {
      get: { summary: 'List call logs', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Calls' } } },
    },
    '/v1/admin/waitlist': {
      get: { summary: 'List waitlist entries', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Waitlist' } } },
    },
    '/v1/admin/enquiries': {
      get: { summary: 'List enquiries', tags: ['admin'], security: [{ adminJwt: [] }], responses: { '200': { description: 'Enquiries' } } },
    },

    '/health': { get: { summary: 'Liveness. Deliberately shallow.', responses: { '200': { description: 'Alive' } } } },
    '/ready': { get: { summary: 'Readiness, checks Postgres and Redis', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } } },
  },
  components: {
    schemas: registry,
    securitySchemes: {
      vonageJwt: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Vonage AI Studio signs each webhook with an HS256 JWT carrying iat, jti and payload_hash (SHA-256 of the raw body). All three are verified against the per-restaurant signing secret.',
      },
      hmacSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Signature',
        description:
          'Generic fallback: hex HMAC-SHA256 over `${timestamp}.${rawBody}`, sent as `v1=<hex>` with X-Timestamp. Five minute window, constant-time compared.',
      },
      adminJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Restaurant-scoped admin token from /v1/admin/login.' },
    },
  },
};

const output = process.argv[2] ?? 'openapi.json';
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `Wrote ${output}: ${Object.keys(document.paths).length} paths, ${Object.keys(registry).length} schemas.`,
);
