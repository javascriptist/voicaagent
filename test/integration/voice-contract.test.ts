import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeSpeechViolation } from '../../src/speech/index.js';
import { signVonageWebhook } from '../../src/lib/vonage.js';
import { localTimeOf } from '../../src/time/zone.js';
import {
  buildTestApp,
  clearHolds,
  db,
  deleteRestaurant,
  infra,
  seedRestaurant,
  teardown,
  upcomingDate,
  voicePost,
  type SeededRestaurant,
  type TestApp,
} from './setup.js';

/**
 * The Vonage AI Studio contract.
 *
 * Two hard requirements, both of which are dropped calls rather than slow or
 * ugly ones when they break:
 *
 *   Every response carries a speech_hint that a Speak node can read verbatim.
 *   AI Studio pipes it straight to text to speech with no model in between.
 *
 *   Every endpoint answers well inside the Webhook node's five second error
 *   branch. The assertion here is 1500 ms, which is already three times the
 *   500 ms p95 target.
 */

const suite = infra.ok ? describe : describe.skip;

const LATENCY_CEILING_MS = 1500;

suite('Vonage AI Studio contract', () => {
  let test: TestApp;
  let restaurant: SeededRestaurant;
  const date = upcomingDate(21);

  beforeAll(async () => {
    test = await buildTestApp();
    restaurant = await seedRestaurant();
  });

  afterAll(async () => {
    await clearHolds(restaurant.id);
    await deleteRestaurant(restaurant.id);
    await test?.close();
    await teardown();
  });

  /**
   * One call of every endpoint, in the order a real conversation makes them.
   * Sequential and stateful on purpose: modify and cancel need a booking to
   * act on, and the ordering is what a real AI Studio flow does.
   */
  async function walkEveryEndpoint(): Promise<
    Array<{ name: string; status: number; ms: number; hint: string }>
  > {
    const results: Array<{ name: string; status: number; ms: number; hint: string }> = [];
    const phone = `+4477${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;

    const call = async (name: string, path: string, body: unknown, key?: string) => {
      const started = performance.now();
      const response = await voicePost(test, restaurant, path, body, { idempotencyKey: key });
      const ms = performance.now() - started;
      const json = response.json() as { speech_hint?: string };
      results.push({ name, status: response.statusCode, ms, hint: json.speech_hint ?? '' });
      return response;
    };

    await call('check-availability', '/check-availability', {
      call_id: 'contract', party_size: 2, date, time: '19:30',
      accessibility: [], seating_preferences: ['booth'],
    });

    const created = await call(
      'create-booking',
      '/create-booking',
      {
        call_id: 'contract', party_size: 2, date, time: '19:30',
        guest_name: "O'Brien", phone,
        accessibility: [], seating_preferences: [],
        allergies_verbatim: 'severe nut allergy, 2 in the party',
      },
      `contract-create-${phone}`,
    );
    const reservationId = created.json().reservation?.id as string;

    await call('lookup-booking', '/lookup-booking', { call_id: 'contract', phone });

    await call(
      'modify-booking',
      '/modify-booking',
      { call_id: 'contract', reservation_id: reservationId, party_size: 3 },
      `contract-modify-${phone}`,
    );

    await call('search-knowledge', '/search-knowledge', {
      call_id: 'contract', query: 'do you have step free access', top_k: 4,
    });

    await call(
      'join-waitlist',
      '/join-waitlist',
      {
        call_id: 'contract', guest_name: 'Waiting', phone: `${phone}1`,
        date, window_start: '19:00', window_end: '21:00', party_size: 2,
        accessibility: [], seating_preferences: [],
      },
      `contract-wait-${phone}`,
    );

    await call(
      'create-enquiry',
      '/create-enquiry',
      {
        call_id: 'contract', category: 'private_hire', guest_name: 'Enquirer',
        phone: `${phone}2`, message: 'Can we hire the private room for 12 on the 3rd?',
      },
      `contract-enq-${phone}`,
    );

    await call('call-events', '/call-events', {
      call_id: 'contract', event: 'call_ended', outcome: 'booked',
      transcript: [{ role: 'caller', text: 'table for two please' }],
    });

    await call('cancel-booking', '/cancel-booking', {
      call_id: 'contract', reservation_id: reservationId,
    });

    return results;
  }

  it('every endpoint returns a speech_hint a Speak node can read verbatim', async () => {
    const results = await walkEveryEndpoint();
    expect(results).toHaveLength(9);

    for (const result of results) {
      expect(result.status, `${result.name} returned ${result.status}`).toBeLessThan(400);
      const violation = describeSpeechViolation(result.hint);
      expect(
        violation,
        `${result.name}: ${violation} in ${JSON.stringify(result.hint)}`,
      ).toBeNull();
    }
  });

  it('no voice endpoint exceeds the latency ceiling', async () => {
    // Warm the connection pool and the query plans first; the first request of
    // a process is not what AI Studio experiences in production.
    await walkEveryEndpoint();
    const results = await walkEveryEndpoint();

    const slowest = [...results].sort((a, b) => b.ms - a.ms);
    const table = slowest.map((r) => `${r.name.padEnd(20)} ${r.ms.toFixed(0)}ms`).join('\n  ');

    for (const result of results) {
      expect(
        result.ms,
        `${result.name} took ${result.ms.toFixed(0)}ms, ceiling is ${LATENCY_CEILING_MS}ms.\n  ${table}`,
      ).toBeLessThan(LATENCY_CEILING_MS);
    }
  });

  it('error responses are speakable too, and carry no stack trace', async () => {
    const failures = [
      // Unknown reservation.
      voicePost(test, restaurant, '/lookup-booking', {
        call_id: 'e', reservation_id: '00000000-0000-4000-8000-000000000000',
      }),
      // Party nobody can seat.
      voicePost(test, restaurant, '/create-booking', {
        call_id: 'e', party_size: 55, date, time: '19:30',
        guest_name: 'Huge', phone: '+447700955001', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'huge' }),
      // Outside service hours.
      voicePost(test, restaurant, '/create-booking', {
        call_id: 'e', party_size: 2, date, time: '04:00',
        guest_name: 'Early', phone: '+447700955002', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'early' }),
      // Malformed body.
      voicePost(test, restaurant, '/create-booking', { call_id: 'e' }, { idempotencyKey: 'bad' }),
    ];

    for (const response of await Promise.all(failures)) {
      const body = response.json();
      const hint = body.speech_hint as string;
      const violation = describeSpeechViolation(hint);
      expect(violation, `${violation} in ${JSON.stringify(hint)}`).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(/prisma|\.ts:|at Object|ZodError/i);
    }
  });

  describe('webhook authentication', () => {
    const body = {
      call_id: 'auth', party_size: 2, date, time: '19:30',
      accessibility: [], seating_preferences: [],
    };

    it('accepts a Vonage AI Studio signed JWT', async () => {
      const response = await voicePost(test, restaurant, '/check-availability', body, {
        scheme: 'vonage',
      });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a JWT signed with the wrong secret', async () => {
      const payload = JSON.stringify(body);
      const response = await test.app.inject({
        method: 'POST',
        url: '/v1/voice/check-availability',
        headers: {
          'content-type': 'application/json',
          'x-restaurant': restaurant.slug,
          authorization: `Bearer ${signVonageWebhook('not-the-secret', payload)}`,
        },
        payload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a valid JWT replayed over a different body', async () => {
      // The attack payload_hash exists to stop: lift a token from a harmless
      // webhook, resend it with a cancel-everything body.
      const original = JSON.stringify(body);
      const tampered = JSON.stringify({ ...body, party_size: 40 });
      const response = await test.app.inject({
        method: 'POST',
        url: '/v1/voice/check-availability',
        headers: {
          'content-type': 'application/json',
          'x-restaurant': restaurant.slug,
          authorization: `Bearer ${signVonageWebhook(restaurant.hmacSecret, original)}`,
        },
        payload: tampered,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('invalid_signature');
    });

    it('rejects a signature older than the window', async () => {
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      const response = await voicePost(test, restaurant, '/check-availability', body, {
        now: stale,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('stale_timestamp');
    });

    it('rejects an unsigned request', async () => {
      const response = await test.app.inject({
        method: 'POST',
        url: '/v1/voice/check-availability',
        headers: { 'content-type': 'application/json', 'x-restaurant': restaurant.slug },
        payload: JSON.stringify(body),
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an unknown restaurant without confirming it is unknown', async () => {
      const payload = JSON.stringify(body);
      const response = await test.app.inject({
        method: 'POST',
        url: '/v1/voice/check-availability',
        headers: {
          'content-type': 'application/json',
          'x-restaurant': 'no-such-restaurant',
          authorization: `Bearer ${signVonageWebhook('whatever', payload)}`,
        },
        payload,
      });
      // Same code as a bad signature: otherwise this enumerates tenants.
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('invalid_signature');
    });
  });
});

/**
 * Daylight saving, through the full stack.
 *
 * The engine tests already cover the arithmetic. This checks the values that
 * actually land in timestamptz columns, because a driver or a Prisma mapping
 * that quietly reinterprets a Date is exactly the kind of bug unit tests miss.
 */
suite('daylight saving through Postgres', () => {
  let test: TestApp;
  let restaurant: SeededRestaurant;

  beforeAll(async () => {
    test = await buildTestApp();
    restaurant = await seedRestaurant({ timezone: 'America/New_York', slugPrefix: 'dst' });
    // Round the clock, so the transition hours are inside service.
    await db.servicePeriod.updateMany({
      where: { restaurantId: restaurant.id },
      data: { startTime: '00:00', endTime: '23:45', lastSeatingOffsetMinutes: 0 },
    });
  });

  afterAll(async () => {
    await clearHolds(restaurant.id);
    await deleteRestaurant(restaurant.id);
    await test?.close();
    await teardown();
  });

  it('refuses a booking in the spring forward gap', async () => {
    const response = await voicePost(test, restaurant, '/create-booking', {
      call_id: 'dst', party_size: 2, date: '2027-03-14', time: '02:30',
      guest_name: 'Gap', phone: '+447700966001', accessibility: [], seating_preferences: [],
    }, { idempotencyKey: 'dst-gap' });

    // 2027-03-14 is the second Sunday in March: 02:00 becomes 03:00.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const hint = response.json().speech_hint as string;
    expect(hint).toMatch(/clocks/i);
    expect(describeSpeechViolation(hint)).toBeNull();
    expect(await db.reservation.count({ where: { restaurantId: restaurant.id } })).toBe(0);
  });

  it('stores a booking spanning the autumn repeat hour as two real hours', async () => {
    // 2027-11-07: 01:59:59 EDT is followed by 01:00:00 EST.
    const response = await voicePost(test, restaurant, '/create-booking', {
      call_id: 'dst', party_size: 5, date: '2027-11-07', time: '01:00',
      guest_name: 'Repeat', phone: '+447700966002', accessibility: [], seating_preferences: [],
    }, { idempotencyKey: 'dst-fallback' });

    expect(response.statusCode).toBe(201);
    const reservation = await db.reservation.findFirstOrThrow({
      where: { restaurantId: restaurant.id, idempotencyKey: 'dst-fallback' },
    });

    // Party of five gets a 120 minute turn time.
    expect(reservation.endsAt.getTime() - reservation.startsAt.getTime()).toBe(120 * 60_000);
    expect(reservation.startsAt.toISOString()).toBe('2027-11-07T05:00:00.000Z');
    expect(reservation.endsAt.toISOString()).toBe('2027-11-07T07:00:00.000Z');
    // The wall clock only advanced one hour, because it was wound back.
    expect(localTimeOf(reservation.startsAt, 'America/New_York')).toBe('01:00');
    expect(localTimeOf(reservation.endsAt, 'America/New_York')).toBe('02:00');
  });

  it('keeps the table blocked through the whole repeated hour', async () => {
    // The first 01:30 (05:30Z) is inside the meal booked above.
    const response = await voicePost(test, restaurant, '/check-availability', {
      call_id: 'dst-check', party_size: 5, date: '2027-11-07', time: '01:30',
      accessibility: [], seating_preferences: [], flexibility_minutes: 0,
    });

    const body = response.json();
    const offeredTable = body.offer?.table?.table_ids?.[0];
    const booked = await db.reservation.findFirstOrThrow({
      where: { restaurantId: restaurant.id, idempotencyKey: 'dst-fallback' },
    });
    // Whatever it offers, it must not be the table that is still occupied.
    if (offeredTable) expect(booked.tableIds).not.toContain(offeredTable);
  });
});
