import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findAvailability } from '../../availability/engine.js';
import { loadSnapshot } from '../../availability/snapshot.js';
import { reference } from '../../booking/service.js';
import { AppError, isAppError } from '../../lib/errors.js';
import { logToolCall } from '../../lib/logger.js';
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
import { localDateOf, localTimeOf, localToUtcOrNull, spokenTime } from '../../time/zone.js';
import {
  CancelBookingRequest,
  CheckAvailabilityRequest,
  CreateBookingRequest,
  CreateEnquiryRequest,
  JoinWaitlistRequest,
  LookupBookingRequest,
  ModifyBookingRequest,
  SearchKnowledgeRequest,
} from '../schemas.js';
import { enforceRateLimit } from '../plugins/rateLimit.js';

/**
 * Vapi adapter.
 *
 * Vapi speaks a different dialect from Vonage AI Studio: everything arrives
 * nested under `message.toolCallList[]`, and the reply must be
 * `{ results: [{ toolCallId, result }] }`. This route does the unwrapping and
 * rewrapping and nothing else — dispatch lands in the same engine, the same
 * BookingService and the same Postgres transaction as the Vonage path, so a
 * booking taken by a Vapi agent and one taken by a Vonage agent cannot
 * collide.
 *
 * One behavioural caveat that is not fixable here: Vapi puts an LLM between
 * this response and the caller's ear, so `speech_hint` is advisory rather than
 * guaranteed. Vonage pipes it straight to text to speech. Tell the Vapi
 * assistant to read it verbatim in the system prompt, and treat it as best
 * effort.
 */

const VAPI_SECRET_HEADER = 'x-vapi-secret';
const RESTAURANT_HEADER = 'x-restaurant';

/** Vapi's envelope. Deliberately loose: unknown fields are ignored, not rejected. */
const VapiEnvelope = z.object({
  message: z.object({
    type: z.string().optional(),
    toolCallList: z
      .array(
        z.object({
          id: z.string().min(1),
          function: z.object({
            name: z.string().min(1),
            // Vapi sends an object; some SDK versions send a JSON string.
            arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
          }),
        }),
      )
      .min(1),
    call: z
      .object({
        id: z.string().optional(),
        customer: z.object({ number: z.string().optional() }).partial().optional(),
      })
      .partial()
      .optional(),
  }),
});

type ToolResult = Record<string, unknown>;

export async function registerVapiRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post('/tools', async (req, reply) => {
    const started = performance.now();

    // --- Tenant -------------------------------------------------------------
    // Vapi lets you set custom headers on the tool server config, so
    // X-Restaurant is honoured when present. This deployment runs one
    // restaurant, so when the header is absent and exactly one exists we use
    // it rather than making the operator configure something with one possible
    // value. Two or more and the header becomes mandatory again.
    const identifier = req.headers[RESTAURANT_HEADER];
    const restaurant =
      typeof identifier === 'string' && identifier.length > 0
        ? await ctx.db.restaurant.findFirst({
            where: isUuid(identifier) ? { id: identifier } : { slug: identifier },
            select: { id: true, slug: true, timezone: true, hmacSecret: true },
          })
        : await soleRestaurant(app);

    if (!restaurant) {
      throw new AppError('unauthorized', 'Restaurant not resolved');
    }

    // --- Auth ---------------------------------------------------------------
    // Vapi's shared-secret scheme: a fixed header value, so the comparison must
    // be constant time or it leaks the secret a byte at a time.
    const presented = req.headers[VAPI_SECRET_HEADER];
    if (typeof presented !== 'string' || !secretsMatch(presented, restaurant.hmacSecret)) {
      throw new AppError('unauthorized', 'Missing or invalid X-Vapi-Secret');
    }

    await enforceRateLimit(ctx.cache, 'vapi', restaurant.id, { limit: 600, windowSeconds: 60 });

    const envelope = VapiEnvelope.parse(req.body);
    const callId = envelope.message.call?.id ?? null;
    const callerNumber = envelope.message.call?.customer?.number ?? null;

    // Vapi may batch several tool calls into one request.
    const results = [];
    for (const toolCall of envelope.message.toolCallList) {
      const name = toolCall.function.name;
      const args = parseArguments(toolCall.function.arguments);
      const toolStarted = performance.now();
      let result: ToolResult;

      try {
        result = await dispatch(app, {
          name,
          args,
          restaurantId: restaurant.id,
          callId,
          callerNumber,
          // Vapi reuses the tool call id across its own retries, which makes it
          // exactly the right idempotency key — better than composing one.
          idempotencyKey: toolCall.id,
        });
      } catch (error) {
        // A failed tool must not fail the whole batch, and the assistant needs
        // something it can say rather than an HTTP error it cannot see.
        const appError = isAppError(error)
          ? error
          : new AppError('internal', String((error as Error)?.message ?? error));
        req.log.warn({ err: appError.message, code: appError.code, tool: name }, 'vapi tool failed');
        result = { ok: false, code: appError.code, speech_hint: appError.speechHint };
      }

      logToolCall({
        tool: `vapi:${name}`,
        restaurantId: restaurant.id,
        callId,
        latencyMs: performance.now() - toolStarted,
        ok: result.ok !== false,
        code: typeof result.code === 'string' ? result.code : undefined,
      });

      results.push({ toolCallId: toolCall.id, result });
    }

    req.log.info(
      { kind: 'vapi_batch', tools: results.length, latency_ms: Math.round(performance.now() - started) },
      'vapi tool batch',
    );

    // Vapi requires exactly this shape.
    return reply.send({ results });
  });
}

// ---------------------------------------------------------------------------

interface DispatchContext {
  name: string;
  args: Record<string, unknown>;
  restaurantId: string;
  callId: string | null;
  callerNumber: string | null;
  idempotencyKey: string;
}

async function dispatch(app: FastifyInstance, d: DispatchContext): Promise<ToolResult> {
  const { ctx } = app;
  // The assistant may omit the phone number when the caller is ringing in;
  // Vapi already knows it, so fall back to that rather than asking again.
  const withCall = { call_id: d.callId ?? 'vapi', ...d.args };
  const withPhone = { ...withCall, phone: d.args.phone ?? d.callerNumber ?? undefined };

  switch (d.name) {
    case 'check_availability': {
      const body = CheckAvailabilityRequest.parse(withCall);
      const snapshot = await loadSnapshot(ctx.db, ctx.holds, d.restaurantId, { date: body.date });
      const tz = snapshot.restaurant.timezone;
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

      if (result.available && result.offer) {
        await ctx.holds.acquire(
          result.offer.assignment.tableIds.map((tableId) => ({
            restaurantId: d.restaurantId,
            tableId,
            startsAt: result.offer!.startsAt,
            endsAt: result.offer!.endsAt,
            callId: body.call_id,
          })),
        );
      }

      return {
        ok: true,
        available: result.available,
        speech_hint: availabilitySpeech(result, tz, localDateOf(ctx.now(), tz)),
        reason: result.reason,
        large_party: result.largeParty,
        offer: result.offer
          ? {
              local_date: result.offer.localDate,
              local_time: result.offer.localTime,
              spoken_time: spokenTime(result.offer.localTime),
              table_ids: result.offer.assignment.tableIds,
              seats: result.offer.assignment.seats,
            }
          : null,
        alternatives: result.alternatives.map((a) => ({
          local_date: a.localDate,
          local_time: a.localTime,
          spoken_time: spokenTime(a.localTime),
        })),
        next_dates: result.nextDates.map((n) => ({
          local_date: n.localDate,
          local_time: n.localTime,
          spoken_time: spokenTime(n.localTime),
        })),
      };
    }

    case 'create_booking': {
      const body = CreateBookingRequest.parse(withPhone);
      const created = await ctx.bookings.create({
        restaurantId: d.restaurantId,
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
        idempotencyKey: d.idempotencyKey,
        preferredTableIds: body.table_ids,
      });

      const tz = await timezoneOf(app, d.restaurantId);
      const localDate = localDateOf(created.reservation.startsAt, tz);
      const localTime = localTimeOf(created.reservation.startsAt, tz);
      return {
        ok: true,
        speech_hint: bookingConfirmedSpeech({
          localDate,
          localTime,
          today: localDateOf(ctx.now(), tz),
          zone: tz,
          partySize: created.reservation.partySize,
          guestName: body.guest_name,
          allergies: body.allergies_verbatim ?? null,
        }),
        reservation_reference: reference(created.reservation.id),
        local_date: localDate,
        local_time: localTime,
        party_size: created.reservation.partySize,
        already_existed: created.idempotentReplay,
      };
    }

    case 'lookup_booking': {
      const body = LookupBookingRequest.parse(withPhone);
      const bookings = await ctx.bookings.lookup({
        restaurantId: d.restaurantId,
        phone: body.phone,
        reservationId: body.reservation_id,
      });
      const tz = await timezoneOf(app, d.restaurantId);
      const today = localDateOf(ctx.now(), tz);
      const rendered = bookings.map((b) => ({
        reference: reference(b.id),
        local_date: localDateOf(b.startsAt, tz),
        local_time: localTimeOf(b.startsAt, tz),
        spoken_time: spokenTime(localTimeOf(b.startsAt, tz)),
        party_size: b.partySize,
      }));
      return {
        ok: true,
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
      };
    }

    case 'modify_booking': {
      const body = ModifyBookingRequest.parse(withPhone);
      const updated = await ctx.bookings.modify({
        restaurantId: d.restaurantId,
        reservationId: body.reservation_id,
        phone: body.phone,
        date: body.date,
        time: body.time,
        partySize: body.party_size,
        accessibility: body.accessibility,
        seatingPreferences: body.seating_preferences,
        notes: body.notes,
        callId: body.call_id,
        idempotencyKey: d.idempotencyKey,
      });
      const tz = await timezoneOf(app, d.restaurantId);
      const localDate = localDateOf(updated.reservation.startsAt, tz);
      const localTime = localTimeOf(updated.reservation.startsAt, tz);
      return {
        ok: true,
        speech_hint: bookingModifiedSpeech({
          localDate,
          localTime,
          today: localDateOf(ctx.now(), tz),
          zone: tz,
          partySize: updated.reservation.partySize,
        }),
        reservation_reference: reference(updated.reservation.id),
        local_date: localDate,
        local_time: localTime,
        party_size: updated.reservation.partySize,
      };
    }

    case 'cancel_booking': {
      const body = CancelBookingRequest.parse(withPhone);
      const cancelled = await ctx.bookings.cancel({
        restaurantId: d.restaurantId,
        reservationId: body.reservation_id,
        phone: body.phone,
        reason: body.reason,
      });
      const tz = await timezoneOf(app, d.restaurantId);
      return {
        ok: true,
        speech_hint: bookingCancelledSpeech({
          localDate: localDateOf(cancelled.startsAt, tz),
          localTime: localTimeOf(cancelled.startsAt, tz),
          today: localDateOf(ctx.now(), tz),
          zone: tz,
        }),
        reservation_reference: reference(cancelled.id),
      };
    }

    case 'search_knowledge': {
      const body = SearchKnowledgeRequest.parse(withCall);
      const hits = await ctx.knowledge.search(d.restaurantId, body.query, body.top_k);
      return {
        ok: true,
        speech_hint: knowledgeSpeech(hits.length > 0, hits[0]?.title),
        results: hits.map((h) => ({ title: h.title, content: h.content })),
      };
    }

    case 'join_waitlist': {
      const body = JoinWaitlistRequest.parse(withPhone);
      const tz = await timezoneOf(app, d.restaurantId);
      const windowStart = localToUtcOrNull(body.date, body.window_start, tz);
      const windowEnd = localToUtcOrNull(body.date, body.window_end, tz);
      if (!windowStart || !windowEnd || windowEnd <= windowStart) {
        throw new AppError('bad_request', 'Invalid waitlist window', {
          speechHint: 'I did not quite catch the times. What is the earliest and latest you could come?',
        });
      }

      const existing = await ctx.db.waitlistEntry.findFirst({
        where: { restaurantId: d.restaurantId, idempotencyKey: d.idempotencyKey },
      });
      const guest = await ctx.db.guest.upsert({
        where: { restaurantId_phone: { restaurantId: d.restaurantId, phone: body.phone } },
        update: body.guest_name ? { name: body.guest_name } : {},
        create: { restaurantId: d.restaurantId, phone: body.phone, name: body.guest_name },
      });
      const entry =
        existing ??
        (await ctx.db.waitlistEntry.create({
          data: {
            restaurantId: d.restaurantId,
            guestId: guest.id,
            date: body.date,
            windowStart,
            windowEnd,
            partySize: body.party_size,
            accessibility: body.accessibility,
            seatingPreferences: body.seating_preferences,
            idempotencyKey: d.idempotencyKey,
            callId: body.call_id,
          },
        }));

      return {
        ok: true,
        speech_hint: waitlistSpeech({
          localDate: body.date,
          today: localDateOf(ctx.now(), tz),
          zone: tz,
          partySize: body.party_size,
        }),
        waitlist_id: entry.id,
      };
    }

    case 'create_enquiry': {
      const body = CreateEnquiryRequest.parse(withPhone);
      const existing = await ctx.db.enquiry.findFirst({
        where: { restaurantId: d.restaurantId, idempotencyKey: d.idempotencyKey },
      });
      const enquiry =
        existing ??
        (await ctx.db.enquiry.create({
          data: {
            restaurantId: d.restaurantId,
            category: body.category,
            guestName: body.guest_name,
            phone: body.phone,
            message: body.message,
            idempotencyKey: d.idempotencyKey,
            callId: body.call_id,
          },
        }));
      return {
        ok: true,
        speech_hint: enquirySpeech(body.guest_name),
        enquiry_id: enquiry.id,
      };
    }

    default:
      return {
        ok: false,
        code: 'not_found',
        speech_hint: acknowledgementSpeech(),
        error: `Unknown tool ${d.name}`,
      };
  }
}

// ---------------------------------------------------------------------------

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function soleRestaurant(app: FastifyInstance) {
  const all = await app.ctx.db.restaurant.findMany({
    select: { id: true, slug: true, timezone: true, hmacSecret: true },
    take: 2,
  });
  return all.length === 1 ? all[0]! : null;
}

async function timezoneOf(app: FastifyInstance, restaurantId: string): Promise<string> {
  const restaurant = await app.ctx.db.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { timezone: true },
  });
  return restaurant.timezone;
}
