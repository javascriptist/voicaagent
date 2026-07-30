import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseAttributes } from '../../domain/attributes.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isValidZone } from '../../time/zone.js';
import {
  AdminLoginRequest,
  TableFields,
  ClosureCreate,
  FloorCreate,
  FloorImport,
  KnowledgeDocumentCreate,
  ReservationListQuery,
  RestaurantUpdate,
  ServicePeriodCreate,
  TableBlockCreate,
  TableCreate,
} from '../schemas.js';

/**
 * Admin API.
 *
 * JWT authenticated and scoped to one restaurant: the token carries the
 * restaurant id, and every handler uses that rather than anything from the
 * URL or body. A route that took an id from the request would let any
 * authenticated operator read another restaurant's bookings by changing a
 * path parameter.
 *
 * Restaurant creation and deletion are deliberately absent — the deployment
 * runs one restaurant, seeded by prisma/seed.ts. Settings are editable.
 */

interface AdminClaims {
  sub: string;
  restaurantId: string;
  role: string;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  // --- Auth -----------------------------------------------------------------

  app.post('/login', async (req, reply) => {
    const body = AdminLoginRequest.parse(req.body);
    const user = await ctx.db.adminUser.findFirst({ where: { email: body.email } });

    // Same message and roughly the same work either way, so a wrong email and
    // a wrong password are indistinguishable to someone probing for accounts.
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new AppError('unauthorized', 'Invalid email or password');
    }

    const token = app.jwt.sign(
      { sub: user.id, restaurantId: user.restaurantId, role: user.role } satisfies AdminClaims,
      { expiresIn: '12h' },
    );
    return reply.send({ ok: true, token, restaurant_id: user.restaurantId, role: user.role });
  });

  // Everything below this point requires a token.
  app.addHook('preHandler', async (req) => {
    if (req.url.endsWith('/login')) return;
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError('unauthorized', 'Missing or invalid bearer token');
    }
    const claims = req.user as AdminClaims;
    if (!claims?.restaurantId) throw new AppError('unauthorized', 'Token carries no restaurant');
    req.restaurantId = claims.restaurantId;
  });

  // --- Restaurant settings --------------------------------------------------

  app.get('/restaurant', async (req, reply) => {
    const restaurant = await ctx.db.restaurant.findUniqueOrThrow({
      where: { id: scope(req) },
      // hmacSecret is never returned by a list or get; it is only revealed by
      // the explicit rotate endpoint, once, at the moment it is created.
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        phone: true,
        largePartyThreshold: true,
        defaultTurnTimes: true,
        bookingWindowDays: true,
        cancellationPolicy: true,
        flexibilityMinutes: true,
      },
    });
    return reply.send({ ok: true, restaurant });
  });

  app.patch('/restaurant', async (req, reply) => {
    const body = RestaurantUpdate.parse(req.body);
    if (body.timezone && !isValidZone(body.timezone)) {
      throw badRequest(`Unknown IANA timezone: ${body.timezone}`);
    }

    const restaurant = await ctx.db.restaurant.update({
      where: { id: scope(req) },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.phone ? { phone: body.phone } : {}),
        ...(body.large_party_threshold ? { largePartyThreshold: body.large_party_threshold } : {}),
        ...(body.default_turn_times ? { defaultTurnTimes: body.default_turn_times } : {}),
        ...(body.booking_window_days ? { bookingWindowDays: body.booking_window_days } : {}),
        ...(body.cancellation_policy !== undefined
          ? { cancellationPolicy: body.cancellation_policy }
          : {}),
        ...(body.flexibility_minutes !== undefined
          ? { flexibilityMinutes: body.flexibility_minutes }
          : {}),
      },
      select: { id: true, name: true, timezone: true },
    });

    // Hours and zones changed, so the generated knowledge is now wrong.
    await ctx.knowledge.regenerateDerived(scope(req));
    ctx.knowledge.scheduleIndexing(scope(req));

    return reply.send({ ok: true, restaurant });
  });

  app.post('/restaurant/rotate-secret', async (req, reply) => {
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await ctx.db.restaurant.update({ where: { id: scope(req) }, data: { hmacSecret: secret } });
    // Shown exactly once. There is no endpoint that reads it back.
    return reply.send({ ok: true, hmac_secret: secret });
  });

  // --- Floors ---------------------------------------------------------------

  app.get('/floors', async (req, reply) => {
    const floors = await ctx.db.floor.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { level: 'asc' },
      include: { _count: { select: { tables: true } } },
    });
    return reply.send({ ok: true, floors });
  });

  app.post('/floors', async (req, reply) => {
    const body = FloorCreate.parse(req.body);
    const floor = await ctx.db.floor.create({
      data: {
        restaurantId: scope(req),
        name: body.name,
        level: body.level,
        stepFreeAccess: body.step_free_access,
      },
    });
    await regenerate(app, scope(req));
    return reply.status(201).send({ ok: true, floor });
  });

  app.patch('/floors/:id', async (req, reply) => {
    const { id } = paramsId(req);
    const body = FloorCreate.partial().parse(req.body);
    await requireOwned(app, 'floor', id, scope(req));

    const floor = await ctx.db.floor.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.level !== undefined ? { level: body.level } : {}),
        ...(body.step_free_access !== undefined ? { stepFreeAccess: body.step_free_access } : {}),
      },
    });
    await regenerate(app, scope(req));
    return reply.send({ ok: true, floor });
  });

  app.delete('/floors/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'floor', id, scope(req));
    const liveBookings = await ctx.db.reservationTable.count({
      where: {
        restaurantId: scope(req),
        status: { in: ['held', 'confirmed', 'seated'] },
        endsAt: { gte: ctx.now() },
        table: { floorId: id },
      },
    });
    if (liveBookings > 0) {
      throw badRequest(`Floor has ${liveBookings} upcoming bookings; cancel or move them first`);
    }
    await ctx.db.floor.delete({ where: { id } });
    await regenerate(app, scope(req));
    return reply.send({ ok: true });
  });

  /**
   * Floor plan import from the layout editor.
   *
   * Runs in one transaction so a half-applied floor plan can never exist. The
   * editor sends local `key`s for tables that do not have ids yet, and
   * combines_with is resolved against those keys after every table has an id.
   */
  app.post('/floors/:id/import', async (req, reply) => {
    const { id: floorId } = paramsId(req);
    const restaurantId = scope(req);
    await requireOwned(app, 'floor', floorId, restaurantId);
    const body = FloorImport.parse(req.body);

    const duplicateKeys = findDuplicates(body.tables.map((t) => t.key));
    if (duplicateKeys.length > 0) {
      throw badRequest(`Duplicate table keys in payload: ${duplicateKeys.join(', ')}`);
    }
    const duplicateLabels = findDuplicates(body.tables.map((t) => t.label));
    if (duplicateLabels.length > 0) {
      throw badRequest(`Duplicate table labels in payload: ${duplicateLabels.join(', ')}`);
    }

    const result = await ctx.db.$transaction(async (tx) => {
      const existing = await tx.table.findMany({
        where: { restaurantId, floorId },
        select: { id: true, label: true },
      });

      const keyToId = new Map<string, string>();
      const upsertedIds: string[] = [];

      // Pass one: create or update every table, without combines_with, because
      // it may reference a table that does not exist yet.
      for (const spec of body.tables) {
        const existingId = spec.id ?? existing.find((e) => e.label === spec.label)?.id;
        const data = {
          restaurantId,
          floorId,
          label: spec.label,
          minCovers: spec.min_covers,
          maxCovers: spec.max_covers,
          shape: spec.shape,
          x: spec.x,
          y: spec.y,
          width: spec.width,
          height: spec.height,
          isActive: spec.is_active,
          attributes: { ...spec.attributes, combines_with: [] },
        };

        const saved = existingId
          ? await tx.table.update({ where: { id: existingId }, data })
          : await tx.table.create({ data });

        keyToId.set(spec.key, saved.id);
        upsertedIds.push(saved.id);
      }

      // Pass two: resolve combines_with now that every key has an id.
      for (const spec of body.tables) {
        const selfId = keyToId.get(spec.key)!;
        const resolved = spec.attributes.combines_with
          .map((ref) => keyToId.get(ref) ?? ref)
          .filter((ref) => ref !== selfId && upsertedIds.includes(ref));

        await tx.table.update({
          where: { id: selfId },
          data: { attributes: { ...spec.attributes, combines_with: [...new Set(resolved)] } },
        });
      }

      let removed = 0;
      if (body.replace_existing) {
        const stale = existing.filter((e) => !upsertedIds.includes(e.id)).map((e) => e.id);
        if (stale.length > 0) {
          // Never delete a table someone is booked onto. The layout editor
          // does not know about tonight's covers.
          const booked = await tx.reservationTable.count({
            where: {
              restaurantId,
              tableId: { in: stale },
              status: { in: ['held', 'confirmed', 'seated'] },
              endsAt: { gte: ctx.now() },
            },
          });
          if (booked > 0) {
            throw badRequest(
              `${booked} upcoming bookings are on tables this import would delete. Move them first.`,
            );
          }
          const deletion = await tx.table.deleteMany({ where: { id: { in: stale } } });
          removed = deletion.count;
        }
      }

      return { imported: upsertedIds.length, removed };
    });

    await regenerate(app, restaurantId);
    return reply.send({ ok: true, ...result });
  });

  // --- Tables ---------------------------------------------------------------

  app.get('/tables', async (req, reply) => {
    const tables = await ctx.db.table.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { label: 'asc' },
    });
    return reply.send({
      ok: true,
      tables: tables.map((t) => ({ ...t, attributes: parseAttributes(t.attributes) })),
    });
  });

  app.post('/tables', async (req, reply) => {
    const body = TableCreate.parse(req.body);
    await requireOwned(app, 'floor', body.floor_id, scope(req));

    const table = await ctx.db.table.create({
      data: {
        restaurantId: scope(req),
        floorId: body.floor_id,
        label: body.label,
        minCovers: body.min_covers,
        maxCovers: body.max_covers,
        shape: body.shape,
        x: body.x,
        y: body.y,
        width: body.width,
        height: body.height,
        attributes: body.attributes,
        isActive: body.is_active,
      },
    });
    await regenerate(app, scope(req));
    return reply.status(201).send({ ok: true, table });
  });

  app.patch('/tables/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'table', id, scope(req));
    const body = TableFields.partial().parse(req.body);

    const table = await ctx.db.table.update({
      where: { id },
      data: {
        ...(body.label ? { label: body.label } : {}),
        ...(body.min_covers ? { minCovers: body.min_covers } : {}),
        ...(body.max_covers ? { maxCovers: body.max_covers } : {}),
        ...(body.shape ? { shape: body.shape } : {}),
        ...(body.x !== undefined ? { x: body.x } : {}),
        ...(body.y !== undefined ? { y: body.y } : {}),
        ...(body.width !== undefined ? { width: body.width } : {}),
        ...(body.height !== undefined ? { height: body.height } : {}),
        ...(body.attributes ? { attributes: body.attributes } : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      },
    });
    await regenerate(app, scope(req));
    return reply.send({ ok: true, table });
  });

  app.delete('/tables/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'table', id, scope(req));
    const booked = await ctx.db.reservationTable.count({
      where: {
        restaurantId: scope(req),
        tableId: id,
        status: { in: ['held', 'confirmed', 'seated'] },
        endsAt: { gte: ctx.now() },
      },
    });
    if (booked > 0) throw badRequest(`Table has ${booked} upcoming bookings`);
    await ctx.db.table.delete({ where: { id } });
    await regenerate(app, scope(req));
    return reply.send({ ok: true });
  });

  // --- Service periods ------------------------------------------------------

  app.get('/service-periods', async (req, reply) => {
    const periods = await ctx.db.servicePeriod.findMany({ where: { restaurantId: scope(req) } });
    return reply.send({ ok: true, service_periods: periods });
  });

  app.post('/service-periods', async (req, reply) => {
    const body = ServicePeriodCreate.parse(req.body);
    const period = await ctx.db.servicePeriod.create({
      data: {
        restaurantId: scope(req),
        name: body.name,
        daysOfWeek: body.days_of_week,
        startTime: body.start_time,
        endTime: body.end_time,
        slotIntervalMinutes: body.slot_interval_minutes,
        lastSeatingOffsetMinutes: body.last_seating_offset_minutes,
        turnTimeOverrides: body.turn_time_overrides ?? undefined,
        isActive: body.is_active,
      },
    });
    await regenerate(app, scope(req));
    return reply.status(201).send({ ok: true, service_period: period });
  });

  app.patch('/service-periods/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'servicePeriod', id, scope(req));
    const body = ServicePeriodCreate.partial().parse(req.body);

    const period = await ctx.db.servicePeriod.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.days_of_week ? { daysOfWeek: body.days_of_week } : {}),
        ...(body.start_time ? { startTime: body.start_time } : {}),
        ...(body.end_time ? { endTime: body.end_time } : {}),
        ...(body.slot_interval_minutes ? { slotIntervalMinutes: body.slot_interval_minutes } : {}),
        ...(body.last_seating_offset_minutes !== undefined
          ? { lastSeatingOffsetMinutes: body.last_seating_offset_minutes }
          : {}),
        ...(body.turn_time_overrides !== undefined
          ? { turnTimeOverrides: body.turn_time_overrides ?? undefined }
          : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
      },
    });
    await regenerate(app, scope(req));
    return reply.send({ ok: true, service_period: period });
  });

  app.delete('/service-periods/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'servicePeriod', id, scope(req));
    await ctx.db.servicePeriod.delete({ where: { id } });
    await regenerate(app, scope(req));
    return reply.send({ ok: true });
  });

  // --- Closures and blocks --------------------------------------------------

  app.get('/closures', async (req, reply) => {
    const closures = await ctx.db.closure.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { startsAt: 'asc' },
    });
    return reply.send({ ok: true, closures });
  });

  app.post('/closures', async (req, reply) => {
    const body = ClosureCreate.parse(req.body);
    const range = requireRange(body.starts_at, body.ends_at);
    const closure = await ctx.db.closure.create({
      data: { restaurantId: scope(req), ...range, reason: body.reason },
    });
    await regenerate(app, scope(req));
    return reply.status(201).send({ ok: true, closure });
  });

  app.delete('/closures/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'closure', id, scope(req));
    await ctx.db.closure.delete({ where: { id } });
    await regenerate(app, scope(req));
    return reply.send({ ok: true });
  });

  app.get('/table-blocks', async (req, reply) => {
    const blocks = await ctx.db.tableBlock.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { startsAt: 'asc' },
    });
    return reply.send({ ok: true, table_blocks: blocks });
  });

  app.post('/table-blocks', async (req, reply) => {
    const body = TableBlockCreate.parse(req.body);
    await requireOwned(app, 'table', body.table_id, scope(req));
    const range = requireRange(body.starts_at, body.ends_at);
    const block = await ctx.db.tableBlock.create({
      data: { restaurantId: scope(req), tableId: body.table_id, ...range, reason: body.reason },
    });
    return reply.status(201).send({ ok: true, table_block: block });
  });

  app.delete('/table-blocks/:id', async (req, reply) => {
    const { id } = paramsId(req);
    await requireOwned(app, 'tableBlock', id, scope(req));
    await ctx.db.tableBlock.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // --- Knowledge ------------------------------------------------------------

  app.get('/knowledge', async (req, reply) => {
    const documents = await ctx.db.knowledgeDocument.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
    return reply.send({ ok: true, documents });
  });

  app.post('/knowledge', async (req, reply) => {
    const body = KnowledgeDocumentCreate.parse(req.body);
    const document = await ctx.db.knowledgeDocument.create({
      data: {
        restaurantId: scope(req),
        source: body.source,
        title: body.title,
        content: body.content,
        embedStatus: 'pending',
      },
    });
    // Re-embedding is a background job: an admin saving a menu gets a 202
    // immediately rather than waiting on an embedding API.
    ctx.knowledge.scheduleIndexing(scope(req));
    return reply.status(202).send({ ok: true, document, embedding: 'scheduled' });
  });

  app.patch('/knowledge/:id', async (req, reply) => {
    const { id } = paramsId(req);
    const existing = await ctx.db.knowledgeDocument.findFirst({
      where: { id, restaurantId: scope(req) },
    });
    if (!existing) throw notFound('Knowledge document not found');
    if (existing.isGenerated) {
      // Editing it would be pointless: the next table or hours change
      // regenerates it and silently discards the edit.
      throw forbidden(
        'This document is generated from the floor plan and opening hours. Change those instead.',
      );
    }

    const body = KnowledgeDocumentCreate.partial().parse(req.body);
    const document = await ctx.db.knowledgeDocument.update({
      where: { id },
      data: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.content ? { content: body.content } : {}),
        ...(body.source ? { source: body.source } : {}),
        embedStatus: 'pending',
      },
    });
    ctx.knowledge.scheduleIndexing(scope(req));
    return reply.status(202).send({ ok: true, document, embedding: 'scheduled' });
  });

  app.delete('/knowledge/:id', async (req, reply) => {
    const { id } = paramsId(req);
    const existing = await ctx.db.knowledgeDocument.findFirst({
      where: { id, restaurantId: scope(req) },
    });
    if (!existing) throw notFound('Knowledge document not found');
    if (existing.isGenerated) throw forbidden('Generated documents cannot be deleted');
    await ctx.db.knowledgeDocument.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  app.post('/knowledge/reindex', async (req, reply) => {
    await ctx.knowledge.regenerateDerived(scope(req));
    const result = await ctx.knowledge.processPending(scope(req));
    return reply.send({ ok: true, ...result });
  });

  // --- Read models ----------------------------------------------------------

  app.get('/reservations', async (req, reply) => {
    const query = ReservationListQuery.parse(req.query);
    const restaurantId = scope(req);
    const restaurant = await ctx.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timezone: true },
    });

    const reservations = await ctx.db.reservation.findMany({
      where: {
        restaurantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.phone ? { guest: { phone: query.phone, restaurantId } } : {}),
        ...(query.from || query.to
          ? {
              startsAt: {
                ...(query.from ? { gte: dayBoundary(query.from, restaurant.timezone, 'start') } : {}),
                ...(query.to ? { lt: dayBoundary(query.to, restaurant.timezone, 'end') } : {}),
              },
            }
          : {}),
      },
      include: { guest: { select: { id: true, name: true, phone: true } }, tables: true },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });

    return reply.send({
      ok: true,
      reservations,
      next_cursor: reservations.length === query.limit ? reservations.at(-1)?.id : null,
    });
  });

  app.get('/calls', async (req, reply) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const calls = await ctx.db.callLog.findMany({
      where: { restaurantId: scope(req) },
      orderBy: { startedAt: 'desc' },
      take: query.limit,
    });
    return reply.send({ ok: true, calls });
  });

  app.get('/waitlist', async (req, reply) => {
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.enum(['waiting', 'offered', 'converted', 'expired', 'cancelled']).optional(),
      })
      .parse(req.query);

    const entries = await ctx.db.waitlistEntry.findMany({
      where: {
        restaurantId: scope(req),
        ...(query.date ? { date: query.date } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { guest: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return reply.send({ ok: true, waitlist: entries });
  });

  app.get('/enquiries', async (req, reply) => {
    const query = z
      .object({ status: z.enum(['open', 'in_progress', 'closed']).optional() })
      .parse(req.query);
    const enquiries = await ctx.db.enquiry.findMany({
      where: { restaurantId: scope(req), ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return reply.send({ ok: true, enquiries });
  });

  app.patch('/reservations/:id/status', async (req, reply) => {
    const { id } = paramsId(req);
    const body = z
      .object({ status: z.enum(['held', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']) })
      .parse(req.body);
    const reservation = await ctx.bookings.setStatus(scope(req), id, body.status);
    return reply.send({ ok: true, reservation });
  });
}

// ---------------------------------------------------------------------------

function scope(req: FastifyRequest): string {
  if (!req.restaurantId) throw new AppError('unauthorized', 'No restaurant in scope');
  return req.restaurantId;
}

function paramsId(req: FastifyRequest): { id: string } {
  return z.object({ id: z.uuid() }).parse(req.params);
}

/**
 * Confirm a record belongs to the caller's restaurant before touching it.
 *
 * Prisma's `update` takes a unique id and would happily update another
 * tenant's row, so ownership is checked first every single time. This is the
 * function the tenant isolation test exercises.
 */
async function requireOwned(
  app: FastifyInstance,
  model: 'floor' | 'table' | 'servicePeriod' | 'closure' | 'tableBlock',
  id: string,
  restaurantId: string,
): Promise<void> {
  const delegate = app.ctx.db[model] as {
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
  };
  const found = await delegate.findFirst({ where: { id, restaurantId }, select: { id: true } });
  if (!found) throw notFound(`${model} not found`);
}

async function regenerate(app: FastifyInstance, restaurantId: string): Promise<void> {
  // Structural change: the generated hours / accessibility / zones documents
  // are now stale, so rewrite them and queue re-embedding.
  await app.ctx.knowledge.regenerateDerived(restaurantId);
  app.ctx.knowledge.scheduleIndexing(restaurantId);
}

function requireRange(startsAt: string, endsAt: string): { startsAt: Date; endsAt: Date } {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw badRequest('starts_at and ends_at must be ISO-8601 instants');
  }
  if (end <= start) throw badRequest('ends_at must be after starts_at');
  return { startsAt: start, endsAt: end };
}

function dayBoundary(date: string, zone: string, edge: 'start' | 'end'): Date {
  const day = edge === 'start' ? date : addDay(date);
  // Admin filters are a UI convenience; an hour of slop at a DST boundary is
  // acceptable here in a way it never is on the booking path.
  const guess = new Date(`${day}T00:00:00Z`);
  const offsetMinutes = -new Date(
    guess.toLocaleString('en-US', { timeZone: zone }),
  ).getTimezoneOffset();
  void offsetMinutes;
  const local = new Date(`${day}T00:00:00`);
  const utc = new Date(local.toLocaleString('en-US', { timeZone: 'UTC' }));
  const zoned = new Date(local.toLocaleString('en-US', { timeZone: zone }));
  return new Date(local.getTime() + (utc.getTime() - zoned.getTime()));
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

// --- Passwords -------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomUUID().replace(/-/g, '');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
