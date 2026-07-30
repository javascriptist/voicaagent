import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * The guarantees that only a real Postgres can demonstrate.
 *
 * Everything here is about the database doing its job: the exclusion
 * constraint, the sync trigger, the unique index on idempotency keys, and the
 * tenant scoping on every query.
 */

const suite = infra.ok ? describe : describe.skip;

suite('booking guarantees', () => {
  let test: TestApp;
  let restaurant: SeededRestaurant;
  const date = upcomingDate(21);

  beforeAll(async () => {
    test = await buildTestApp();
  });

  afterAll(async () => {
    await test?.close();
    await teardown();
  });

  afterEach(async () => {
    if (restaurant) {
      await clearHolds(restaurant.id);
      await deleteRestaurant(restaurant.id);
    }
  });

  // -------------------------------------------------------------------------

  describe('no double bookings under concurrency', () => {
    it('fires fifty parallel bookings at one table and exactly one succeeds', async () => {
      // One table, one slot, fifty callers. This is the test the whole design
      // exists to pass.
      restaurant = await seedRestaurant({ rich: false });
      await db.table.deleteMany({
        where: { restaurantId: restaurant.id, label: { in: ['PLAIN1', 'PLAIN2'] } },
      });

      const attempts = Array.from({ length: 50 }, (_, i) =>
        voicePost(
          test,
          restaurant,
          '/create-booking',
          {
            call_id: `call-${i}`,
            party_size: 2,
            date,
            time: '19:30',
            guest_name: `Guest ${i}`,
            phone: `+4477000000${String(i).padStart(2, '0')}`,
            accessibility: [],
            seating_preferences: [],
          },
          // Distinct keys: this must be decided by the exclusion constraint,
          // not accidentally deduplicated by idempotency.
          { idempotencyKey: `key-${i}` },
        ),
      );

      const responses = await Promise.all(attempts);
      const created = responses.filter((r) => r.statusCode === 201);
      const rejected = responses.filter((r) => r.statusCode !== 201);

      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(49);

      // And the database agrees.
      const live = await db.reservation.count({
        where: { restaurantId: restaurant.id, status: { in: ['held', 'confirmed', 'seated'] } },
      });
      expect(live).toBe(1);

      const rows = await db.reservationTable.count({
        where: { restaurantId: restaurant.id, status: { in: ['held', 'confirmed', 'seated'] } },
      });
      expect(rows).toBe(1);
    });

    it('tells the forty-nine losers something a person can say out loud', async () => {
      restaurant = await seedRestaurant({ rich: false });
      await db.table.deleteMany({
        where: { restaurantId: restaurant.id, label: { in: ['PLAIN1', 'PLAIN2'] } },
      });

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          voicePost(
            test,
            restaurant,
            '/create-booking',
            {
              call_id: `call-${i}`,
              party_size: 2,
              date,
              time: '20:00',
              guest_name: `Guest ${i}`,
              phone: `+4477100000${String(i).padStart(2, '0')}`,
              accessibility: [],
              seating_preferences: [],
            },
            { idempotencyKey: `loser-key-${i}` },
          ),
        ),
      );

      for (const response of responses.filter((r) => r.statusCode !== 201)) {
        const body = response.json();
        expect(body.ok).toBe(false);
        expect(body.speech_hint).toBeTruthy();
        // Never a stack trace, never a Prisma error.
        expect(JSON.stringify(body)).not.toMatch(/prisma|constraint|at Object|\.ts:/i);
        expect(body).not.toHaveProperty('stack');
      }
    });

    it('lets two parties book the same slot on different tables', async () => {
      restaurant = await seedRestaurant({ rich: false });

      const [a, b] = await Promise.all([
        voicePost(test, restaurant, '/create-booking', {
          call_id: 'a', party_size: 2, date, time: '19:30',
          guest_name: 'A', phone: '+447712345001', accessibility: [], seating_preferences: [],
        }, { idempotencyKey: 'a' }),
        voicePost(test, restaurant, '/create-booking', {
          call_id: 'b', party_size: 2, date, time: '19:30',
          guest_name: 'B', phone: '+447712345002', accessibility: [], seating_preferences: [],
        }, { idempotencyKey: 'b' }),
      ]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201]);
      const reservations = await db.reservation.findMany({ where: { restaurantId: restaurant.id } });
      expect(reservations).toHaveLength(2);
      // Different tables.
      expect(new Set(reservations.flatMap((r) => r.tableIds)).size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns the same reservation twice and never creates a second', async () => {
      restaurant = await seedRestaurant();
      const body = {
        call_id: 'call-idem',
        party_size: 2,
        date,
        time: '19:30',
        guest_name: 'Repeat Caller',
        phone: '+447700900123',
        accessibility: [],
        seating_preferences: [],
      };

      const first = await voicePost(test, restaurant, '/create-booking', body, {
        idempotencyKey: 'same-key',
      });
      const second = await voicePost(test, restaurant, '/create-booking', body, {
        idempotencyKey: 'same-key',
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().reservation.id).toBe(first.json().reservation.id);
      expect(second.json().idempotent_replay).toBe(true);

      const count = await db.reservation.count({ where: { restaurantId: restaurant.id } });
      expect(count).toBe(1);
    });

    it('survives the two requests racing', async () => {
      restaurant = await seedRestaurant();
      const body = {
        call_id: 'call-race',
        party_size: 2,
        date,
        time: '20:30',
        guest_name: 'Racer',
        phone: '+447700900124',
        accessibility: [],
        seating_preferences: [],
      };

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          voicePost(test, restaurant, '/create-booking', body, { idempotencyKey: 'race-key' }),
        ),
      );

      const ids = new Set(
        responses.filter((r) => r.statusCode < 300).map((r) => r.json().reservation.id),
      );
      expect(ids.size).toBe(1);
      expect(await db.reservation.count({ where: { restaurantId: restaurant.id } })).toBe(1);
    });

    it('refuses a write with no Idempotency-Key', async () => {
      restaurant = await seedRestaurant();
      const response = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'no-key',
        party_size: 2,
        date,
        time: '19:30',
        guest_name: 'No Key',
        phone: '+447700900125',
        accessibility: [],
        seating_preferences: [],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().speech_hint).toBeTruthy();
    });

    it('scopes keys per restaurant, so two tenants can use the same one', async () => {
      restaurant = await seedRestaurant();
      const other = await seedRestaurant();
      try {
        const body = (phone: string) => ({
          call_id: 'c', party_size: 2, date, time: '19:30',
          guest_name: 'Shared Key', phone, accessibility: [], seating_preferences: [],
        });

        const a = await voicePost(test, restaurant, '/create-booking', body('+447700900200'), {
          idempotencyKey: 'shared',
        });
        const b = await voicePost(test, other, '/create-booking', body('+447700900201'), {
          idempotencyKey: 'shared',
        });

        expect(a.statusCode).toBe(201);
        expect(b.statusCode).toBe(201);
        expect(a.json().reservation.id).not.toBe(b.json().reservation.id);
      } finally {
        await deleteRestaurant(other.id);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('restaurant A cannot read restaurant B bookings', async () => {
      restaurant = await seedRestaurant({ slugPrefix: 'tenant-a' });
      const b = await seedRestaurant({ slugPrefix: 'tenant-b' });

      try {
        const phone = '+447700911111';
        const created = await voicePost(test, b, '/create-booking', {
          call_id: 'b-call', party_size: 2, date, time: '19:30',
          guest_name: 'B Guest', phone, accessibility: [], seating_preferences: [],
        }, { idempotencyKey: 'b-only' });
        expect(created.statusCode).toBe(201);
        const bReservationId = created.json().reservation.id;

        // A looks up the same phone number, signed with A's own secret.
        const lookup = await voicePost(test, restaurant, '/lookup-booking', {
          call_id: 'a-call',
          phone,
        });
        expect(lookup.statusCode).toBe(200);
        expect(lookup.json().bookings).toHaveLength(0);

        // A asks for B's reservation by id, which is the sharper version of
        // the same question.
        const byId = await voicePost(test, restaurant, '/lookup-booking', {
          call_id: 'a-call-2',
          reservation_id: bReservationId,
        });
        expect(byId.json().bookings).toHaveLength(0);

        // A tries to cancel it.
        const cancel = await voicePost(test, restaurant, '/cancel-booking', {
          call_id: 'a-call-3',
          reservation_id: bReservationId,
        });
        expect(cancel.statusCode).toBe(404);

        // A tries to move it.
        const modify = await voicePost(test, restaurant, '/modify-booking', {
          call_id: 'a-call-4',
          reservation_id: bReservationId,
          time: '21:00',
        }, { idempotencyKey: 'a-steal' });
        expect(modify.statusCode).toBe(404);

        // B's booking is untouched.
        const still = await db.reservation.findUniqueOrThrow({ where: { id: bReservationId } });
        expect(still.status).toBe('confirmed');
        expect(still.restaurantId).toBe(b.id);
      } finally {
        await deleteRestaurant(b.id);
      }
    });

    it('rejects a request signed with the wrong restaurant secret', async () => {
      restaurant = await seedRestaurant({ slugPrefix: 'tenant-a' });
      const b = await seedRestaurant({ slugPrefix: 'tenant-b' });
      try {
        const body = { call_id: 'x', party_size: 2, date, time: '19:30', accessibility: [], seating_preferences: [] };
        // B's slug, A's secret.
        const response = await test.app.inject({
          method: 'POST',
          url: '/v1/voice/check-availability',
          headers: {
            ...(() => {
              const { signedHeaders } = require('../../src/lib/hmac.js');
              return signedHeaders(restaurant.hmacSecret, JSON.stringify(body));
            })(),
            'content-type': 'application/json',
            'x-restaurant': b.slug,
          },
          payload: JSON.stringify(body),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('invalid_signature');
      } finally {
        await deleteRestaurant(b.id);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('holds', () => {
    it('treats a live hold as busy and frees the slot when it expires', async () => {
      // One second TTL, so expiry is observable without a fake clock.
      const shortHold = await buildTestApp({ holdTtlSeconds: 1 });
      restaurant = await seedRestaurant({ rich: false });
      await db.table.deleteMany({
        where: { restaurantId: restaurant.id, label: { in: ['PLAIN1', 'PLAIN2'] } },
      });

      try {
        const query = {
          call_id: 'holder',
          party_size: 2,
          date,
          time: '19:30',
          accessibility: [],
          seating_preferences: [],
        };

        const first = await voicePost(shortHold, restaurant, '/check-availability', query);
        expect(first.json().available).toBe(true);
        expect(first.json().hold.held).toBe(true);

        // A different call sees the table as busy.
        const blocked = await voicePost(shortHold, restaurant, '/check-availability', {
          ...query,
          call_id: 'other',
          flexibility_minutes: 0,
        });
        expect(blocked.json().available).toBe(false);

        // Wait for the hold to lapse.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const afterExpiry = await voicePost(shortHold, restaurant, '/check-availability', {
          ...query,
          call_id: 'other',
        });
        expect(afterExpiry.json().available).toBe(true);
      } finally {
        await shortHold.close();
      }
    });

    it('does not block the caller who owns the hold', async () => {
      restaurant = await seedRestaurant({ rich: false });
      await db.table.deleteMany({
        where: { restaurantId: restaurant.id, label: { in: ['PLAIN1', 'PLAIN2'] } },
      });

      const query = {
        call_id: 'same-caller',
        party_size: 2,
        date,
        time: '19:30',
        accessibility: [],
        seating_preferences: [],
      };

      await voicePost(test, restaurant, '/check-availability', query);
      // The agent re-checks mid-call, as it does constantly.
      const again = await voicePost(test, restaurant, '/check-availability', query);
      expect(again.json().available).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('cancel frees the table', () => {
    it('lets someone else book the slot after a cancellation', async () => {
      restaurant = await seedRestaurant({ rich: false });
      await db.table.deleteMany({
        where: { restaurantId: restaurant.id, label: { in: ['PLAIN1', 'PLAIN2'] } },
      });

      const created = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'first', party_size: 2, date, time: '19:30',
        guest_name: 'First', phone: '+447700922001', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'first' });
      expect(created.statusCode).toBe(201);

      const blocked = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'second', party_size: 2, date, time: '19:30',
        guest_name: 'Second', phone: '+447700922002', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'second' });
      expect(blocked.statusCode).toBe(409);

      const cancelled = await voicePost(test, restaurant, '/cancel-booking', {
        call_id: 'first', reservation_id: created.json().reservation.id,
      });
      expect(cancelled.statusCode).toBe(200);

      // The trigger propagated the status to reservation_tables, taking those
      // rows out of the exclusion constraint's scope.
      const childRows = await db.reservationTable.findMany({
        where: { reservationId: created.json().reservation.id },
      });
      expect(childRows.every((r) => r.status === 'cancelled')).toBe(true);

      const retry = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'third', party_size: 2, date, time: '19:30',
        guest_name: 'Third', phone: '+447700922003', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'third' });
      expect(retry.statusCode).toBe(201);
    });

    it('cancelling twice succeeds rather than conflicting', async () => {
      restaurant = await seedRestaurant();
      const created = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'c', party_size: 2, date, time: '19:30',
        guest_name: 'Cancel Twice', phone: '+447700933001', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'ct' });

      const id = created.json().reservation.id;
      const first = await voicePost(test, restaurant, '/cancel-booking', { call_id: 'c', reservation_id: id });
      const second = await voicePost(test, restaurant, '/cancel-booking', { call_id: 'c', reservation_id: id });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------

  describe('accessibility is a hard filter at the HTTP layer too', () => {
    it('never returns a table without clearance, even when nothing else is free', async () => {
      restaurant = await seedRestaurant();

      // Take the one accessible table out for the whole evening.
      await db.tableBlock.create({
        data: {
          restaurantId: restaurant.id,
          tableId: restaurant.tableIds.ACC!,
          startsAt: new Date(`${date}T12:00:00Z`),
          endsAt: new Date(`${date}T23:59:00Z`),
          reason: 'maintenance',
        },
      });

      const response = await voicePost(test, restaurant, '/check-availability', {
        call_id: 'wheelchair',
        party_size: 2,
        date,
        time: '19:30',
        accessibility: ['wheelchair_space'],
        seating_preferences: [],
        flexibility_minutes: 120,
      });

      const body = response.json();
      expect(body.available).toBe(false);
      expect(body.offer).toBeNull();
      expect(body.alternatives).toHaveLength(0);
      expect(body.speech_hint).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------

  describe('SMS', () => {
    it('sends a confirmation on create and a cancellation on cancel', async () => {
      restaurant = await seedRestaurant();
      test.notifier.sent.length = 0;

      const created = await voicePost(test, restaurant, '/create-booking', {
        call_id: 'sms', party_size: 2, date, time: '19:30',
        guest_name: 'Texted', phone: '+447700944001', accessibility: [], seating_preferences: [],
      }, { idempotencyKey: 'sms' });

      expect(test.notifier.sent.filter((s) => s.kind === 'confirmed')).toHaveLength(1);

      await voicePost(test, restaurant, '/cancel-booking', {
        call_id: 'sms', reservation_id: created.json().reservation.id,
      });
      expect(test.notifier.sent.filter((s) => s.kind === 'cancelled')).toHaveLength(1);
    });
  });
});
