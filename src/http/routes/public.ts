import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findAvailability } from '../../availability/engine.js';
import { loadSnapshot } from '../../availability/snapshot.js';
import { reference } from '../../booking/service.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { localDateOf, localTimeOf, spokenTime } from '../../time/zone.js';
import { enforceRateLimit } from '../plugins/rateLimit.js';
import { PublicAvailabilityRequest, PublicBookingRequest } from '../schemas.js';

/**
 * Public endpoints for the web booking widget.
 *
 * These run the same availability engine and the same BookingService as the
 * phone. That is the point: two code paths would eventually disagree about
 * whether a table is free, and the disagreement would be a double booking
 * between a web guest and a caller. Sharing the engine makes it impossible.
 *
 * Unauthenticated, so they are rate limited by IP and never expose table ids,
 * internal reasons or anything that would let a scraper map the floor plan.
 */

const SlugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,64}$/) });

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  async function resolveRestaurant(slug: string) {
    const restaurant = await ctx.db.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, timezone: true, cancellationPolicy: true, bookingWindowDays: true },
    });
    if (!restaurant) throw notFound('Restaurant not found');
    return restaurant;
  }

  app.addHook('preHandler', async (req) => {
    await enforceRateLimit(ctx.cache, 'public', req.ip, { limit: 60, windowSeconds: 60 });
  });

  app.get('/:slug', async (req, reply) => {
    const { slug } = SlugParams.parse(req.params);
    const restaurant = await resolveRestaurant(slug);
    const periods = await ctx.db.servicePeriod.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      select: { name: true, daysOfWeek: true, startTime: true, endTime: true },
    });

    return reply.send({
      ok: true,
      restaurant: {
        name: restaurant.name,
        timezone: restaurant.timezone,
        booking_window_days: restaurant.bookingWindowDays,
        cancellation_policy: restaurant.cancellationPolicy,
        service_periods: periods,
      },
    });
  });

  app.post('/:slug/availability', async (req, reply) => {
    const { slug } = SlugParams.parse(req.params);
    const body = PublicAvailabilityRequest.parse(req.body);
    const restaurant = await resolveRestaurant(slug);

    const snapshot = await loadSnapshot(ctx.db, ctx.holds, restaurant.id, { date: body.date });
    const result = findAvailability(snapshot, {
      partySize: body.party_size,
      date: body.date,
      time: body.time,
      accessibility: body.accessibility,
      seatingPreferences: body.seating_preferences,
      flexibilityMinutes: body.flexibility_minutes,
      now: ctx.now(),
    });

    // The widget gets times, not tables. Exposing table ids to an
    // unauthenticated endpoint hands a scraper the floor plan and lets them
    // watch which tables fill up.
    const publicSlot = (slot: (typeof result.alternatives)[number]) => ({
      local_date: slot.localDate,
      local_time: slot.localTime,
      spoken_time: spokenTime(slot.localTime),
      starts_at: slot.startsAt.toISOString(),
      seats_up_to: slot.assignment.seats,
    });

    return reply.send({
      ok: true,
      available: result.available,
      requires_call: result.largeParty || result.reason === 'party_too_large',
      offer: result.offer ? publicSlot(result.offer) : null,
      alternatives: result.alternatives.map(publicSlot),
      next_dates: result.nextDates.map(publicSlot),
    });
  });

  app.post('/:slug/bookings', async (req, reply) => {
    const { slug } = SlugParams.parse(req.params);
    const body = PublicBookingRequest.parse(req.body);
    const restaurant = await resolveRestaurant(slug);

    // Stricter than the voice line: a web form can always retry cleanly, and
    // this is an unauthenticated write.
    await enforceRateLimit(ctx.cache, 'public-booking', req.ip, { limit: 5, windowSeconds: 300 });

    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw badRequest('Missing Idempotency-Key header');
    }

    const result = await ctx.bookings.create({
      restaurantId: restaurant.id,
      date: body.date,
      time: body.time,
      partySize: body.party_size,
      guest: { phone: body.phone, name: body.guest_name },
      accessibility: body.accessibility,
      seatingPreferences: body.seating_preferences,
      allergiesVerbatim: body.allergies_verbatim ?? null,
      occasion: body.occasion ?? null,
      notes: body.notes ?? '',
      source: 'web',
      idempotencyKey: idempotencyKey.trim(),
    });

    return reply.status(result.idempotentReplay ? 200 : 201).send({
      ok: true,
      booking: {
        reference: reference(result.reservation.id),
        local_date: localDateOf(result.reservation.startsAt, restaurant.timezone),
        local_time: localTimeOf(result.reservation.startsAt, restaurant.timezone),
        starts_at: result.reservation.startsAt.toISOString(),
        party_size: result.reservation.partySize,
      },
    });
  });
}
