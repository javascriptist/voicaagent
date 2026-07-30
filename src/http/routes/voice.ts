import type { FastifyInstance, FastifyRequest } from 'fastify';
import { findAvailability } from '../../availability/engine.js';
import { loadSnapshot } from '../../availability/snapshot.js';
import type { AvailabilityResult, SlotOption } from '../../availability/types.js';
import { reference } from '../../booking/service.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '../../lib/hmac.js';
import { verifyVonageWebhook } from '../../lib/vonage.js';
import {
  addMinutes,
  localDateOf,
  localTimeOf,
  localToUtcOrNull,
  spokenDate,
  spokenTime,
} from '../../time/zone.js';
import {
  CallEventRequest,
  CancelBookingRequest,
  CheckAvailabilityRequest,
  CreateBookingRequest,
  CreateEnquiryRequest,
  JoinWaitlistRequest,
  LookupBookingRequest,
  ModifyBookingRequest,
  SearchKnowledgeRequest,
} from '../schemas.js';
import {
  acknowledgementSpeech,
  availabilitySpeech,
  bookingCancelledSpeech,
  bookingConfirmedSpeech,
  bookingModifiedSpeech,
  enquirySpeech,
  knowledgeSpeech,
  lookupSpeech,
  waitlistSpeech,
} from '../../speech/hints.js';
import { enforceRateLimit } from '../plugins/rateLimit.js';

/**
 * Voice tool endpoints.
 *
 * Constraints that shape every handler here:
 *
 *   The caller is on the phone. No synchronous model call, no unbounded scan,
 *   and the availability path never waits on anything but Postgres and Redis.
 *
 *   Every response carries `speech_hint`, a sentence to read verbatim. It is
 *   built from the same data as the structured fields, so the two cannot
 *   disagree.
 *
 *   Every write is idempotent through the Idempotency-Key header.
 */

const RESTAURANT_HEADER = 'x-restaurant';

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /**
   * Resolve the tenant, then verify the signature with that tenant's secret.
   *
   * The restaurant travels in a header rather than the body so we never have
   * to parse untrusted JSON to decide which key to check the signature with.
   */
  app.addHook('preHandler', async (req) => {
    const identifier = req.headers[RESTAURANT_HEADER];
    if (typeof identifier !== 'string' || identifier.length === 0) {
      throw new AppError('unauthorized', `Missing ${RESTAURANT_HEADER} header`);
    }

    const restaurant = await ctx.db.restaurant.findFirst({
      where: isUuid(identifier) ? { id: identifier } : { slug: identifier },
      select: { id: true, slug: true, hmacSecret: true },
    });
    if (!restaurant) {
      // Same error as a bad signature: telling an unauthenticated caller which
      // restaurant slugs exist is a free tenant enumeration.
      throw new AppError('invalid_signature', `Unknown restaurant ${identifier}`);
    }

    verifyWebhook(req, restaurant.hmacSecret, ctx);

    req.restaurantId = restaurant.id;
    req.restaurantSlug = restaurant.slug;

    await enforceRateLimit(ctx.cache, 'voice', restaurant.id, { limit: 600, windowSeconds: 60 });
  });

  // --- check-availability ---------------------------------------------------

  app.post('/check-availability', async (req, reply) => {
    req.toolName = 'check_availability';
    const body = CheckAvailabilityRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const snapshot = await loadSnapshot(ctx.db, ctx.holds, restaurantId, { date: body.date });
    const tz = snapshot.restaurant.timezone;
    const today = localDateOf(ctx.now(), tz);

    const result = findAvailability(snapshot, {
      partySize: body.party_size,
      date: body.date,
      time: body.time,
      accessibility: body.accessibility,
      seatingPreferences: body.seating_preferences,
      flexibilityMinutes: body.flexibility_minutes,
      now: ctx.now(),
      callId: body.call_id,
    });

    // Hold the offered tables so a second caller is not offered them during
    // the ten seconds it takes to say yes. Advisory only — see holds/store.ts.
    let held = false;
    let expiresAt: string | null = null;
    if (result.available && result.offer) {
      held = await ctx.holds.acquire(
        result.offer.assignment.tableIds.map((tableId) => ({
          restaurantId,
          tableId,
          startsAt: result.offer!.startsAt,
          endsAt: result.offer!.endsAt,
          callId: body.call_id,
        })),
      );
      if (held) {
        expiresAt = addMinutes(ctx.now(), ctx.holdTtlSeconds / 60).toISOString();
      }
    }

    return reply.send({
      ok: true as const,
      available: result.available,
      speech_hint: availabilitySpeech(result, tz, today),
      reason: result.reason,
      large_party: result.largeParty,
      turn_time_minutes: result.turnTimeMinutes,
      offer: result.offer ? serialiseSlot(result.offer, snapshot.tables) : null,
      alternatives: result.alternatives.map((a) => serialiseSlot(a, snapshot.tables)),
      next_dates: result.nextDates.map((d) => serialiseSlot(d, snapshot.tables)),
      hold: {
        held,
        expires_at: expiresAt,
        table_ids: result.offer?.assignment.tableIds ?? [],
      },
    });
  });

  // --- create-booking -------------------------------------------------------

  app.post('/create-booking', async (req, reply) => {
    req.toolName = 'create_booking';
    const body = CreateBookingRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const result = await ctx.bookings.create({
      restaurantId,
      date: body.date,
      time: body.time,
      partySize: body.party_size,
      guest: { phone: body.phone, name: body.guest_name },
      accessibility: body.accessibility,
      seatingPreferences: body.seating_preferences,
      allergiesVerbatim: body.allergies_verbatim ?? null,
      occasion: body.occasion ?? null,
      notes: body.notes ?? '',
      source: 'voice',
      callId: body.call_id,
      idempotencyKey: idempotencyKey(req, true),
      preferredTableIds: body.table_ids,
    });

    const tz = await timezoneOf(ctx, restaurantId);
    const localDate = localDateOf(result.reservation.startsAt, tz);
    const localTime = localTimeOf(result.reservation.startsAt, tz);

    return reply.status(result.idempotentReplay ? 200 : 201).send({
      ok: true as const,
      speech_hint: bookingConfirmedSpeech({
        localDate,
        localTime,
        today: localDateOf(ctx.now(), tz),
        zone: tz,
        partySize: result.reservation.partySize,
        guestName: body.guest_name,
        allergies: body.allergies_verbatim ?? null,
      }),
      reservation: {
        id: result.reservation.id,
        reference: reference(result.reservation.id),
        status: result.reservation.status,
        starts_at: result.reservation.startsAt.toISOString(),
        ends_at: result.reservation.endsAt.toISOString(),
        local_date: localDate,
        local_time: localTime,
        party_size: result.reservation.partySize,
        table_labels: result.tableLabels,
      },
      idempotent_replay: result.idempotentReplay,
    });
  });

  // --- lookup-booking -------------------------------------------------------

  app.post('/lookup-booking', async (req, reply) => {
    req.toolName = 'lookup_booking';
    const body = LookupBookingRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const bookings = await ctx.bookings.lookup({
      restaurantId,
      phone: body.phone,
      reservationId: body.reservation_id,
    });

    const tz = await timezoneOf(ctx, restaurantId);
    const today = localDateOf(ctx.now(), tz);
    const tableLabels = await labelLookup(ctx, bookings.flatMap((b) => b.tables.map((t) => t.tableId)));

    const rendered = bookings.map((b) => ({
      id: b.id,
      reference: reference(b.id),
      status: b.status,
      starts_at: b.startsAt.toISOString(),
      local_date: localDateOf(b.startsAt, tz),
      local_time: localTimeOf(b.startsAt, tz),
      spoken_when: `${spokenTime(localTimeOf(b.startsAt, tz))} on ${spokenDate(localDateOf(b.startsAt, tz), today, tz)}`,
      party_size: b.partySize,
      table_labels: b.tables.map((t) => tableLabels.get(t.tableId) ?? t.tableId),
    }));

    return reply.send({
      ok: true as const,
      speech_hint: lookupSpeech(
        rendered.map((r) => ({
          localDate: r.local_date,
          localTime: r.local_time,
          partySize: r.party_size,
        })),
        today,
        tz,
      ),
      bookings: rendered,
    });
  });

  // --- modify-booking -------------------------------------------------------

  app.post('/modify-booking', async (req, reply) => {
    req.toolName = 'modify_booking';
    const body = ModifyBookingRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const result = await ctx.bookings.modify({
      restaurantId,
      reservationId: body.reservation_id,
      date: body.date,
      time: body.time,
      partySize: body.party_size,
      accessibility: body.accessibility,
      seatingPreferences: body.seating_preferences,
      notes: body.notes,
      callId: body.call_id,
      idempotencyKey: idempotencyKey(req, true),
    });

    const tz = await timezoneOf(ctx, restaurantId);
    const localDate = localDateOf(result.reservation.startsAt, tz);
    const localTime = localTimeOf(result.reservation.startsAt, tz);
    const today = localDateOf(ctx.now(), tz);

    return reply.send({
      ok: true as const,
      speech_hint: bookingModifiedSpeech({
        localDate,
        localTime,
        today,
        zone: tz,
        partySize: result.reservation.partySize,
      }),
      reservation: {
        id: result.reservation.id,
        reference: reference(result.reservation.id),
        status: result.reservation.status,
        starts_at: result.reservation.startsAt.toISOString(),
        ends_at: result.reservation.endsAt.toISOString(),
        local_date: localDate,
        local_time: localTime,
        party_size: result.reservation.partySize,
        table_labels: result.tableLabels,
      },
      idempotent_replay: result.idempotentReplay,
    });
  });

  // --- cancel-booking -------------------------------------------------------

  app.post('/cancel-booking', async (req, reply) => {
    req.toolName = 'cancel_booking';
    const body = CancelBookingRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const cancelled = await ctx.bookings.cancel({
      restaurantId,
      reservationId: body.reservation_id,
      phone: body.phone,
      reason: body.reason,
    });

    const tz = await timezoneOf(ctx, restaurantId);
    const localDate = localDateOf(cancelled.startsAt, tz);
    const localTime = localTimeOf(cancelled.startsAt, tz);

    return reply.send({
      ok: true as const,
      speech_hint: bookingCancelledSpeech({
        localDate,
        localTime,
        today: localDateOf(ctx.now(), tz),
        zone: tz,
      }),
      cancelled: {
        id: cancelled.id,
        reference: reference(cancelled.id),
        starts_at: cancelled.startsAt.toISOString(),
        local_date: localDate,
        local_time: localTime,
      },
    });
  });

  // --- search-knowledge -----------------------------------------------------

  app.post('/search-knowledge', async (req, reply) => {
    req.toolName = 'search_knowledge';
    const body = SearchKnowledgeRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const results = await ctx.knowledge.search(restaurantId, body.query, body.top_k);

    return reply.send({
      ok: true as const,
      speech_hint: knowledgeSpeech(results.length > 0, results[0]?.title),
      results: results.map((r) => ({
        title: r.title,
        source: r.source,
        content: r.content,
        score: r.score,
      })),
    });
  });

  // --- join-waitlist --------------------------------------------------------

  app.post('/join-waitlist', async (req, reply) => {
    req.toolName = 'join_waitlist';
    const body = JoinWaitlistRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const tz = await timezoneOf(ctx, restaurantId);
    const windowStart = localToUtcOrNull(body.date, body.window_start, tz);
    const windowEnd = localToUtcOrNull(body.date, body.window_end, tz);
    if (!windowStart || !windowEnd || windowEnd <= windowStart) {
      throw badRequest(
        'Invalid waitlist window',
        'I did not quite catch the times. What is the earliest and latest you could come?',
      );
    }

    const key = idempotencyKey(req, true);
    const existing = key
      ? await ctx.db.waitlistEntry.findFirst({ where: { restaurantId, idempotencyKey: key } })
      : null;

    const guest = await ctx.db.guest.upsert({
      where: { restaurantId_phone: { restaurantId, phone: body.phone } },
      update: body.guest_name ? { name: body.guest_name } : {},
      create: { restaurantId, phone: body.phone, name: body.guest_name },
    });

    const entry =
      existing ??
      (await ctx.db.waitlistEntry.create({
        data: {
          restaurantId,
          guestId: guest.id,
          date: body.date,
          windowStart,
          windowEnd,
          partySize: body.party_size,
          accessibility: body.accessibility,
          seatingPreferences: body.seating_preferences,
          idempotencyKey: key,
          callId: body.call_id,
        },
      }));

    return reply.status(existing ? 200 : 201).send({
      ok: true as const,
      speech_hint: waitlistSpeech({
        localDate: body.date,
        today: localDateOf(ctx.now(), tz),
        zone: tz,
        partySize: body.party_size,
      }),
      waitlist_entry: {
        id: entry.id,
        date: entry.date,
        window_start: entry.windowStart.toISOString(),
        window_end: entry.windowEnd.toISOString(),
        party_size: entry.partySize,
        status: entry.status,
      },
    });
  });

  // --- create-enquiry -------------------------------------------------------

  app.post('/create-enquiry', async (req, reply) => {
    req.toolName = 'create_enquiry';
    const body = CreateEnquiryRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    const key = idempotencyKey(req, true);
    const existing = key
      ? await ctx.db.enquiry.findFirst({ where: { restaurantId, idempotencyKey: key } })
      : null;

    const enquiry =
      existing ??
      (await ctx.db.enquiry.create({
        data: {
          restaurantId,
          category: body.category,
          guestName: body.guest_name,
          phone: body.phone,
          message: body.message,
          idempotencyKey: key,
          callId: body.call_id,
        },
      }));

    return reply.status(existing ? 200 : 201).send({
      ok: true as const,
      speech_hint: enquirySpeech(body.guest_name),
      enquiry: { id: enquiry.id, category: enquiry.category, status: enquiry.status },
    });
  });

  // --- call-events ----------------------------------------------------------

  app.post('/call-events', async (req, reply) => {
    req.toolName = 'call_events';
    const body = CallEventRequest.parse(req.body);
    req.callId = body.call_id;
    const restaurantId = requireRestaurant(req);

    // Events arrive out of order and more than once, so this is an upsert that
    // only ever fills in fields, never blanks them.
    await ctx.db.callLog.upsert({
      where: { restaurantId_callId: { restaurantId, callId: body.call_id } },
      create: {
        restaurantId,
        callId: body.call_id,
        callerNumber: body.caller_number ?? null,
        startedAt: body.started_at ? new Date(body.started_at) : ctx.now(),
        endedAt: body.ended_at ? new Date(body.ended_at) : null,
        outcome: body.outcome ?? null,
        recordingUrl: body.recording_url ?? null,
        transcript: body.transcript ?? [],
      },
      update: {
        ...(body.caller_number ? { callerNumber: body.caller_number } : {}),
        ...(body.started_at ? { startedAt: new Date(body.started_at) } : {}),
        ...(body.ended_at ? { endedAt: new Date(body.ended_at) } : {}),
        ...(body.outcome ? { outcome: body.outcome } : {}),
        ...(body.recording_url ? { recordingUrl: body.recording_url } : {}),
        ...(body.transcript ? { transcript: body.transcript } : {}),
      },
    });

    return reply.send({
      ok: true as const,
      // Telemetry, not a turn in the conversation, but AI Studio still reads
      // whatever is in this field, so it cannot be empty.
      speech_hint: acknowledgementSpeech(),
      call_id: body.call_id,
    });
  });
}

// ---------------------------------------------------------------------------

function requireRestaurant(req: FastifyRequest): string {
  if (!req.restaurantId) throw new AppError('unauthorized', 'Restaurant not resolved');
  return req.restaurantId;
}

/**
 * Verify the webhook came from Vonage AI Studio, or from a generic HMAC
 * client, depending on WEBHOOK_AUTH.
 *
 * `both` exists so the web widget and local testing keep working without a
 * Vonage account. It tries the Vonage JWT first because that is what
 * production sends; the HMAC path is only reached when no Authorization
 * header is present, so an attacker cannot downgrade a JWT request to the
 * weaker scheme by stripping a header — a missing signature header fails too.
 */
function verifyWebhook(
  req: FastifyRequest,
  secret: string,
  ctx: FastifyInstance['ctx'],
): void {
  const rawBody = req.rawBody ?? '';
  const authorization = req.headers.authorization;
  const mode = ctx.webhookAuth;

  if (mode === 'vonage_jwt') {
    verifyVonageWebhook({
      secret,
      rawBody,
      authorizationHeader: authorization,
      windowSeconds: ctx.hmacWindowSeconds,
      now: ctx.now(),
    });
    return;
  }

  if (mode === 'hmac') {
    verifySignature({
      secret,
      rawBody,
      signatureHeader: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestampHeader: req.headers[TIMESTAMP_HEADER] as string | undefined,
      windowSeconds: ctx.hmacWindowSeconds,
      now: ctx.now(),
    });
    return;
  }

  // both
  if (authorization) {
    verifyVonageWebhook({
      secret,
      rawBody,
      authorizationHeader: authorization,
      windowSeconds: ctx.hmacWindowSeconds,
      now: ctx.now(),
    });
    return;
  }
  verifySignature({
    secret,
    rawBody,
    signatureHeader: req.headers[SIGNATURE_HEADER] as string | undefined,
    timestampHeader: req.headers[TIMESTAMP_HEADER] as string | undefined,
    windowSeconds: ctx.hmacWindowSeconds,
    now: ctx.now(),
  });
}

/**
 * Idempotency-Key header.
 *
 * Required on writes: without it a retry after a network timeout silently
 * double books, and the voice platform retries aggressively because a dropped
 * response mid-call is common.
 */
function idempotencyKey(req: FastifyRequest, required: boolean): string | null {
  const raw = req.headers['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    if (required) {
      throw badRequest(
        'Missing Idempotency-Key header',
        'Sorry, let me try that again.',
      );
    }
    return null;
  }
  if (key.length > 200) throw badRequest('Idempotency-Key too long');
  return key;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function timezoneOf(ctx: FastifyInstance['ctx'], restaurantId: string): Promise<string> {
  const restaurant = await ctx.db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { timezone: true },
  });
  if (!restaurant) throw notFound('Restaurant not found');
  return restaurant.timezone;
}

async function labelLookup(
  ctx: FastifyInstance['ctx'],
  tableIds: string[],
): Promise<Map<string, string>> {
  if (tableIds.length === 0) return new Map();
  const tables = await ctx.db.table.findMany({
    where: { id: { in: [...new Set(tableIds)] } },
    select: { id: true, label: true },
  });
  return new Map(tables.map((t) => [t.id, t.label]));
}

function serialiseSlot(
  slot: SlotOption,
  tables: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  const labels = slot.assignment.tableIds.map(
    (id) => tables.find((t) => t.id === id)?.label ?? id,
  );
  return {
    starts_at: slot.startsAt.toISOString(),
    ends_at: slot.endsAt.toISOString(),
    local_date: slot.localDate,
    local_time: slot.localTime,
    spoken_time: spokenTime(slot.localTime),
    service_period: slot.servicePeriodName,
    turn_time_minutes: slot.turnTimeMinutes,
    delta_minutes: slot.deltaMinutes,
    table: {
      table_ids: slot.assignment.tableIds,
      table_labels: labels,
      is_combination: slot.assignment.isCombination,
      zone: slot.assignment.zone,
      seats: slot.assignment.seats,
      matched_preferences: slot.assignment.matchedPreferences,
      unmatched_preferences: slot.assignment.unmatchedPreferences,
    },
  };
}

export type { AvailabilityResult };
