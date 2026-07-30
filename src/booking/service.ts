import type { PrismaClient, Reservation, ReservationStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { findAvailability } from '../availability/engine.js';
import { loadSnapshot } from '../availability/snapshot.js';
import type { AvailabilityResult, Snapshot } from '../availability/types.js';
import type { AccessibilityRequirement } from '../domain/accessibility.js';
import type { SeatingPreference } from '../domain/preferences.js';
import type { HoldStore } from '../holds/store.js';
import { AppError, badRequest, notFound, slotTaken } from '../lib/errors.js';
import type { Notifier } from '../notify/notifier.js';
import {
  addMinutes,
  localDateOf,
  localTimeOf,
  NonExistentLocalTimeError,
  type LocalDate,
  type LocalTime,
} from '../time/zone.js';
import { unavailableSpeech } from '../speech/hints.js';
import { isExclusionViolation, isUniqueViolation } from './errors.js';

/**
 * Reservation writes.
 *
 * The whole design rests on one idea: Redis holds and the availability engine
 * are advisory, and the exclusion constraint on reservation_tables is the
 * truth. Every path here is written assuming the engine's answer may be stale
 * by the time the INSERT runs, because under concurrency it always is.
 */

export interface BookingDeps {
  db: PrismaClient;
  holds: HoldStore;
  notifier: Notifier;
  now?: () => Date;
}

export type ReservationWithTables = Reservation & {
  tables: Array<{ tableId: string }>;
};

export interface BookingResult {
  reservation: ReservationWithTables;
  /** True when an existing reservation was returned for a repeated key. */
  idempotentReplay: boolean;
  /** Empty on a replay. */
  tableLabels: string[];
}

export interface CreateBookingInput {
  restaurantId: string;
  date: LocalDate;
  time: LocalTime;
  partySize: number;
  guest: { phone: string; name: string };
  accessibility?: AccessibilityRequirement[];
  seatingPreferences?: SeatingPreference[];
  allergiesVerbatim?: string | null;
  occasion?: string | null;
  notes?: string;
  source: 'voice' | 'web' | 'walk_in';
  callId?: string | null;
  idempotencyKey?: string | null;
  /**
   * Tables from a preceding check-availability. Honoured when they are still
   * bookable, so the guest gets the table they were actually offered rather
   * than being told "a booth by the window" and seated at the bar.
   */
  preferredTableIds?: string[];
}

export interface ModifyBookingInput {
  restaurantId: string;
  reservationId: string;
  date?: LocalDate;
  time?: LocalTime;
  partySize?: number;
  accessibility?: AccessibilityRequirement[];
  seatingPreferences?: SeatingPreference[];
  notes?: string;
  callId?: string | null;
  idempotencyKey?: string | null;
}

export class BookingService {
  private readonly now: () => Date;

  constructor(private readonly deps: BookingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(input: CreateBookingInput): Promise<BookingResult> {
    // Idempotency, cheap path. The unique index is what actually enforces it;
    // this just avoids doing the work twice at all.
    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(input.restaurantId, input.idempotencyKey);
      if (existing) return this.replay(existing);
    }

    const snapshot = await loadSnapshot(this.deps.db, this.deps.holds, input.restaurantId, {
      date: input.date,
    });

    const availability = this.evaluate(snapshot, input);
    if (!availability.available || !availability.offer) {
      throw this.unavailableError(availability, snapshot);
    }

    const chosen = this.chooseTables(snapshot, input, availability);
    const { startsAt, endsAt } = availability.offer;
    const guest = await this.upsertGuest(input.restaurantId, input.guest);

    let reservation: ReservationWithTables;
    try {
      reservation = await this.insert({ input, guestId: guest.id, tableIds: chosen, startsAt, endsAt });
    } catch (error) {
      if (isUniqueViolation(error) && input.idempotencyKey) {
        // Two requests with the same key raced. The other won; return its
        // reservation rather than a conflict the caller cannot act on.
        const existing = await this.findByIdempotencyKey(input.restaurantId, input.idempotencyKey);
        if (existing) return this.replay(existing);
      }
      if (isExclusionViolation(error)) {
        // Someone took the table between the engine's answer and the INSERT.
        // Expected under concurrency, not a bug.
        throw slotTaken(
          'Table taken concurrently',
          'Sorry, that table has just gone. Let me find you another time.',
        );
      }
      throw error;
    }

    await this.releaseHolds(input.restaurantId, chosen, startsAt, input.callId);
    await this.notifyConfirmed(snapshot, reservation, guest.name, guest.phone);

    return {
      reservation,
      idempotentReplay: false,
      tableLabels: labelsFor(snapshot, chosen),
    };
  }

  /**
   * The transaction that makes double booking impossible.
   *
   * Three layers, and only the third is load-bearing:
   *
   *   SELECT ... FOR UPDATE on the candidate table rows serialises concurrent
   *   attempts on the same table so they queue instead of colliding. This is a
   *   throughput optimisation — it turns fifty simultaneous aborts into fifty
   *   ordered attempts, of which forty-nine find the table gone and fail
   *   cleanly rather than deadlocking.
   *
   *   The insert writes one reservation_tables row per table.
   *
   *   The exclusion constraint rejects any row overlapping a live booking on
   *   the same table. This is the guarantee. It holds against application
   *   bugs, against a second process, against someone using psql.
   */
  private async insert(params: {
    input: CreateBookingInput;
    guestId: string;
    tableIds: string[];
    startsAt: Date;
    endsAt: Date;
  }): Promise<ReservationWithTables> {
    const { input, guestId, tableIds, startsAt, endsAt } = params;
    // Deterministic order so two overlapping combinations cannot deadlock by
    // taking the same rows in opposite orders.
    const ordered = [...tableIds].sort();

    return this.deps.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM tables
           WHERE id = ANY(${ordered}::uuid[])
             AND restaurant_id = ${input.restaurantId}::uuid
           ORDER BY id
             FOR UPDATE
        `;
        if (locked.length !== ordered.length) {
          // A table id that does not belong to this restaurant, or was deleted
          // mid-flight. Ids arriving over the wire are never trusted.
          throw badRequest('One or more tables do not belong to this restaurant');
        }

        const created = await tx.reservation.create({
          data: {
            restaurantId: input.restaurantId,
            guestId,
            tableIds: ordered,
            startsAt,
            endsAt,
            partySize: input.partySize,
            status: 'confirmed',
            source: input.source,
            accessibility: input.accessibility ?? [],
            seatingPreferences: input.seatingPreferences ?? [],
            allergiesVerbatim: input.allergiesVerbatim ?? null,
            occasion: input.occasion ?? null,
            notes: input.notes ?? '',
            idempotencyKey: input.idempotencyKey ?? null,
            callId: input.callId ?? null,
            tables: {
              create: ordered.map((tableId) => ({
                restaurantId: input.restaurantId,
                tableId,
                startsAt,
                endsAt,
                status: 'confirmed' as const,
              })),
            },
          },
          include: { tables: { select: { tableId: true } } },
        });

        await tx.guest.update({ where: { id: guestId }, data: { visitCount: { increment: 1 } } });
        return created;
      },
      {
        // Short. Fifty callers queueing on one table must not each wait five
        // seconds; the losers should hear "that has just gone" immediately.
        timeout: 5_000,
        maxWait: 5_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  async lookup(params: {
    restaurantId: string;
    phone?: string;
    reservationId?: string;
    includePast?: boolean;
  }): Promise<ReservationWithTables[]> {
    if (!params.phone && !params.reservationId) {
      throw badRequest('Provide a phone number or a reservation id');
    }

    return this.deps.db.reservation.findMany({
      where: {
        // Tenant scope first and always.
        restaurantId: params.restaurantId,
        ...(params.reservationId ? { id: params.reservationId } : {}),
        ...(params.phone
          ? { guest: { phone: params.phone, restaurantId: params.restaurantId } }
          : {}),
        // A booking that started an hour ago is still "their booking" to a
        // guest ringing to say they are running late.
        ...(params.includePast ? {} : { startsAt: { gte: addMinutes(this.now(), -120) } }),
        status: { in: ['held', 'confirmed', 'seated'] },
      },
      include: { tables: { select: { tableId: true } } },
      orderBy: { startsAt: 'asc' },
      take: 10,
    });
  }

  // -------------------------------------------------------------------------
  // Modify
  // -------------------------------------------------------------------------

  async modify(input: ModifyBookingInput): Promise<BookingResult> {
    const { db } = this.deps;

    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(input.restaurantId, input.idempotencyKey);
      if (existing) return this.replay(existing);
    }

    const current = await db.reservation.findFirst({
      where: { id: input.reservationId, restaurantId: input.restaurantId },
      include: { tables: { select: { tableId: true } }, guest: true },
    });
    if (!current) throw notFound('Reservation not found');
    if (current.status === 'cancelled') {
      throw badRequest(
        'Reservation is already cancelled',
        'That booking has already been cancelled. Would you like me to make a new one?',
      );
    }

    // The restaurant's zone is needed to read the existing booking's local
    // time, so it has to be fetched before the date defaults are resolved.
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: input.restaurantId },
      select: { timezone: true },
    });
    const tz = restaurant.timezone;

    const date = input.date ?? localDateOf(current.startsAt, tz);
    const time = input.time ?? localTimeOf(current.startsAt, tz);
    const partySize = input.partySize ?? current.partySize;

    const snapshot = await loadSnapshot(db, this.deps.holds, input.restaurantId, { date });

    // Ignore this reservation's own occupancy, so "same table, half an hour
    // later" is not blocked by the booking being moved.
    const availability = findAvailability(snapshot, {
      partySize,
      date,
      time,
      accessibility: input.accessibility ?? asStringArray<AccessibilityRequirement>(current.accessibility),
      seatingPreferences:
        input.seatingPreferences ?? asStringArray<SeatingPreference>(current.seatingPreferences),
      now: this.now(),
      callId: input.callId ?? null,
      excludeReservationId: current.id,
    });

    if (!availability.available || !availability.offer) {
      throw this.unavailableError(availability, snapshot);
    }

    const chosen = availability.offer.assignment.tableIds;
    const { startsAt, endsAt } = availability.offer;

    try {
      const updated = await db.$transaction(
        async (tx) => {
          const ordered = [...chosen].sort();
          await tx.$queryRaw`
            SELECT id FROM tables
             WHERE id = ANY(${ordered}::uuid[])
               AND restaurant_id = ${input.restaurantId}::uuid
             ORDER BY id
               FOR UPDATE
          `;

          // Replace the child rows rather than updating them: the table set may
          // have changed entirely. The delete and the insert are in one
          // transaction, so the new rows still face the exclusion constraint
          // against everyone else's bookings — just not against the old ones.
          await tx.reservationTable.deleteMany({ where: { reservationId: current.id } });

          return tx.reservation.update({
            where: { id: current.id },
            data: {
              tableIds: ordered,
              startsAt,
              endsAt,
              partySize,
              ...(input.accessibility ? { accessibility: input.accessibility } : {}),
              ...(input.seatingPreferences ? { seatingPreferences: input.seatingPreferences } : {}),
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
              tables: {
                create: ordered.map((tableId) => ({
                  restaurantId: input.restaurantId,
                  tableId,
                  startsAt,
                  endsAt,
                  status: current.status,
                })),
              },
            },
            include: { tables: { select: { tableId: true } } },
          });
        },
        { timeout: 5_000, maxWait: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );

      return { reservation: updated, idempotentReplay: false, tableLabels: labelsFor(snapshot, chosen) };
    } catch (error) {
      if (isExclusionViolation(error)) throw slotTaken('Table taken concurrently');
      if (isUniqueViolation(error) && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.restaurantId, input.idempotencyKey);
        if (existing) return this.replay(existing);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  async cancel(input: {
    restaurantId: string;
    reservationId?: string;
    phone?: string;
    reason?: string;
  }): Promise<ReservationWithTables> {
    const { db } = this.deps;
    if (!input.reservationId && !input.phone) {
      throw badRequest('Provide a reservation id or a phone number');
    }

    const target = await db.reservation.findFirst({
      where: {
        restaurantId: input.restaurantId,
        ...(input.reservationId
          ? { id: input.reservationId }
          : {
              guest: { phone: input.phone, restaurantId: input.restaurantId },
              status: { in: ['held', 'confirmed'] },
              startsAt: { gte: this.now() },
            }),
      },
      include: { tables: { select: { tableId: true } }, guest: true },
      orderBy: { startsAt: 'asc' },
    });

    if (!target) throw notFound('No upcoming booking found to cancel');

    // Cancelling twice is a success, not a conflict: the agent may retry, and
    // the guest's intent is already satisfied.
    if (target.status === 'cancelled') return target;

    const cancelled = await db.reservation.update({
      where: { id: target.id },
      data: {
        status: 'cancelled',
        cancelledAt: this.now(),
        cancellationReason: input.reason ?? null,
      },
      include: { tables: { select: { tableId: true } } },
    });
    // The trigger on reservations propagates the status to reservation_tables,
    // which takes those rows out of the exclusion constraint's WHERE clause and
    // frees the table. No second write, and no way for the two to disagree.

    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: input.restaurantId },
      select: { name: true, timezone: true },
    });
    await this.deps.notifier.bookingCancelled({
      to: target.guest.phone,
      restaurantName: restaurant.name,
      guestName: target.guest.name,
      when: whenText(cancelled.startsAt, restaurant.timezone),
      partySize: cancelled.partySize,
      reference: reference(cancelled.id),
    });

    return cancelled;
  }

  /** Mark a reservation seated / completed / no-show. Used by the admin API. */
  async setStatus(
    restaurantId: string,
    reservationId: string,
    status: ReservationStatus,
  ): Promise<ReservationWithTables> {
    const existing = await this.deps.db.reservation.findFirst({
      where: { id: reservationId, restaurantId },
      select: { id: true },
    });
    if (!existing) throw notFound('Reservation not found');

    const updated = await this.deps.db.reservation.update({
      where: { id: reservationId },
      data: { status },
      include: { tables: { select: { tableId: true } } },
    });

    if (status === 'no_show') {
      await this.deps.db.guest.update({
        where: { id: updated.guestId },
        data: { noShowCount: { increment: 1 } },
      });
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private evaluate(snapshot: Snapshot, input: CreateBookingInput): AvailabilityResult {
    try {
      return findAvailability(snapshot, {
        partySize: input.partySize,
        date: input.date,
        time: input.time,
        accessibility: input.accessibility ?? [],
        seatingPreferences: input.seatingPreferences ?? [],
        now: this.now(),
        callId: input.callId ?? null,
      });
    } catch (error) {
      if (error instanceof NonExistentLocalTimeError) {
        throw badRequest(
          error.message,
          'That time does not exist on that date, the clocks go forward that night. Shall I try an hour either side?',
        );
      }
      throw error;
    }
  }

  /**
   * Prefer the tables the caller was already offered, when they still work.
   *
   * Re-running the engine over a snapshot containing only those tables is the
   * honest way to ask "are these still bookable" — it applies exactly the same
   * accessibility filter, capacity rules and occupancy checks rather than a
   * second, subtly different set of conditions that could drift from them.
   */
  private chooseTables(
    snapshot: Snapshot,
    input: CreateBookingInput,
    availability: AvailabilityResult,
  ): string[] {
    const offered = availability.offer!.assignment.tableIds;
    const preferred = input.preferredTableIds;
    if (!preferred || preferred.length === 0) return offered;
    if (sameSet(preferred, offered)) return offered;

    const restricted: Snapshot = {
      ...snapshot,
      tables: snapshot.tables.filter((t) => preferred.includes(t.id)),
    };
    const check = findAvailability(restricted, {
      partySize: input.partySize,
      date: input.date,
      time: input.time,
      accessibility: input.accessibility ?? [],
      seatingPreferences: input.seatingPreferences ?? [],
      now: this.now(),
      callId: input.callId ?? null,
    });

    if (check.available && check.offer && sameSet(check.offer.assignment.tableIds, preferred)) {
      return check.offer.assignment.tableIds;
    }
    // They have gone. Take what the engine offers now and let the speech hint
    // describe the table honestly.
    return offered;
  }

  private async releaseHolds(
    restaurantId: string,
    tableIds: string[],
    startsAt: Date,
    callId: string | null | undefined,
  ): Promise<void> {
    if (!callId) return;
    await this.deps.holds
      .release(
        tableIds.map((tableId) => ({ restaurantId, tableId, startsAt })),
        callId,
      )
      .catch(() => undefined);
  }

  private async findByIdempotencyKey(
    restaurantId: string,
    idempotencyKey: string,
  ): Promise<ReservationWithTables | null> {
    return this.deps.db.reservation.findFirst({
      where: { restaurantId, idempotencyKey },
      include: { tables: { select: { tableId: true } } },
    });
  }

  private async replay(reservation: ReservationWithTables): Promise<BookingResult> {
    const tables = await this.deps.db.table.findMany({
      where: { id: { in: reservation.tables.map((t) => t.tableId) } },
      select: { label: true },
    });
    return {
      reservation,
      idempotentReplay: true,
      tableLabels: tables.map((t) => t.label),
    };
  }

  private async upsertGuest(restaurantId: string, guest: { phone: string; name: string }) {
    return this.deps.db.guest.upsert({
      where: { restaurantId_phone: { restaurantId, phone: guest.phone } },
      // Never overwrite a stored name with a blank one from a noisy line.
      update: guest.name ? { name: guest.name } : {},
      create: { restaurantId, phone: guest.phone, name: guest.name || 'Guest' },
    });
  }

  private async notifyConfirmed(
    snapshot: Snapshot,
    reservation: Reservation,
    guestName: string,
    phone: string,
  ): Promise<void> {
    const restaurant = await this.deps.db.restaurant.findUnique({
      where: { id: snapshot.restaurant.id },
      select: { name: true, cancellationPolicy: true },
    });
    await this.deps.notifier.bookingConfirmed({
      to: phone,
      restaurantName: restaurant?.name ?? 'The restaurant',
      guestName,
      when: whenText(reservation.startsAt, snapshot.restaurant.timezone),
      partySize: reservation.partySize,
      reference: reference(reservation.id),
      cancellationPolicy: restaurant?.cancellationPolicy || undefined,
    });
  }

  /**
   * Turn an unavailable result into an error the agent can read aloud.
   *
   * Each reason gets its own sentence because "no availability" is useless to
   * a caller: "the accessible tables are taken then, I could do eight o'clock"
   * lets them decide, and "we only book ninety days ahead" stops them asking
   * again.
   */
  /**
   * Turn an unavailable result into an error the agent can read aloud.
   *
   * Delegates to the same speech builders the success path uses, so there is
   * one place that decides how a refusal is worded and one place that
   * guarantees it is speakable.
   */
  private unavailableError(availability: AvailabilityResult, snapshot: Snapshot): AppError {
    const tz = snapshot.restaurant.timezone;
    const today = localDateOf(this.now(), tz);
    return new AppError('slot_taken', `Unavailable: ${availability.reason}`, {
      speechHint: unavailableSpeech(availability, tz, today),
      details: { reason: availability.reason },
    });
  }
}

// ---------------------------------------------------------------------------

/** Short human reference for SMS: the last six characters of the uuid. */
export function reference(id: string): string {
  return id.replace(/-/g, '').slice(-6).toUpperCase();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

function labelsFor(snapshot: Snapshot, tableIds: readonly string[]): string[] {
  return tableIds.map((id) => snapshot.tables.find((t) => t.id === id)?.label ?? id);
}

/** jsonb arrays come back as `unknown`; keep only the strings. */
function asStringArray<T extends string>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as T[]) : [];
}

function whenText(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}
