import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/http/routes/admin.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { buildEmbedder, buildReranker } from '../src/knowledge/embedder.js';
import { redis } from '../src/lib/redis.js';
import { isValidZone } from '../src/time/zone.js';
import type { TableAttributes, Zone } from '../src/domain/attributes.js';

/**
 * Initialise a production database.
 *
 * Non-destructive: it creates what is missing and leaves what exists alone, so
 * it is safe to re-run after a failed deploy. It never touches reservations or
 * guests.
 *
 * It seeds a *bookable* restaurant, not just a row in `restaurants`. A
 * restaurant with no tables makes the availability engine answer
 * `party_too_large` to every query, and one with no service period answers
 * `not_a_service_time` — the agent picks up the phone and refuses every
 * booking, which looks like a bug in the engine rather than missing setup.
 * So the floor, the tables and the service periods are part of the minimum.
 *
 * Usage:
 *   tsx prisma/seed-prod.ts <email> <password> <hmacSecret> [name] [slug] [timezone] [phone]
 *
 * Everything after hmacSecret is optional. Tables are generated from
 * DEFAULT_ROOM below; edit it, or use the admin API afterwards.
 */

const db = new PrismaClient();

interface TableSpec {
  label: string;
  min: number;
  max: number;
  attributes: Partial<TableAttributes> & { zone: Zone };
  /** Labels this table can be pushed against. */
  combinesWith?: string[];
}

/**
 * A small but complete room: enough that every engine path has something to
 * find, and nothing that pretends to be a real floor plan.
 */
const DEFAULT_ROOM: TableSpec[] = [
  { label: 'T1', min: 1, max: 2, attributes: { zone: 'main', near_window: true, noise_level: 'quiet' } },
  { label: 'T2', min: 1, max: 2, attributes: { zone: 'main', near_window: true, noise_level: 'quiet' } },
  { label: 'T3', min: 2, max: 4, attributes: { zone: 'main', seat_type: 'booth' } },
  { label: 'T4', min: 2, max: 4, attributes: { zone: 'main', seat_type: 'booth' } },
  { label: 'T5', min: 2, max: 4, attributes: { zone: 'main' } },
  { label: 'T6', min: 4, max: 6, attributes: { zone: 'main' } },
  // At least one table a wheelchair user can actually be seated at. Without
  // this, every accessibility request is correctly but uselessly refused.
  { label: 'A1', min: 1, max: 4, attributes: { zone: 'main', is_wheelchair_accessible: true, has_wheelchair_clearance: true } },
  { label: 'A2', min: 2, max: 6, attributes: { zone: 'main', is_wheelchair_accessible: true, has_wheelchair_clearance: true } },
  // A combinable run, so parties above the largest single table still fit.
  { label: 'C1', min: 2, max: 4, attributes: { zone: 'terrace', is_combinable: true }, combinesWith: ['C2'] },
  { label: 'C2', min: 2, max: 4, attributes: { zone: 'terrace', is_combinable: true }, combinesWith: ['C1', 'C3'] },
  { label: 'C3', min: 2, max: 6, attributes: { zone: 'terrace', is_combinable: true }, combinesWith: ['C2'] },
];

function fullAttributes(spec: TableSpec): TableAttributes {
  return {
    seat_type: 'chair',
    is_wheelchair_accessible: false,
    has_wheelchair_clearance: false,
    near_window: false,
    near_entrance: false,
    near_toilets: false,
    near_kitchen: false,
    near_speakers: false,
    noise_level: 'normal',
    is_combinable: false,
    combines_with: [],
    ...spec.attributes,
  };
}

async function main(): Promise<void> {
  // argv: [node, script, email, password, hmacSecret, name?, slug?, tz?, phone?]
  const [email, password, hmacSecret, name, slug, tz, phoneArg] = process.argv.slice(2);
  const restaurantName = name || 'My Restaurant';
  const restaurantSlug = slug || 'my-restaurant';
  const timezone = tz || 'Europe/London';
  const phone = phoneArg || '+440000000000';

  if (!email || !password || !hmacSecret) {
    console.error(
      'Usage: tsx prisma/seed-prod.ts <email> <password> <hmacSecret> [name] [slug] [timezone] [phone]',
    );
    process.exit(1);
  }

  // Fail before writing anything rather than halfway through.
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (hmacSecret.length < 16) {
    console.error(
      'hmacSecret must be at least 16 characters. Generate one with: openssl rand -hex 32',
    );
    process.exit(1);
  }
  if (!isValidZone(timezone)) {
    console.error(`Unknown IANA timezone: ${timezone}. Try Europe/London or America/New_York.`);
    process.exit(1);
  }
  if (!/^[a-z0-9-]{2,64}$/.test(restaurantSlug)) {
    console.error(`Slug must be lowercase letters, digits and hyphens: got "${restaurantSlug}".`);
    process.exit(1);
  }

  console.log(`Initialising "${restaurantName}" (${restaurantSlug}, ${timezone})`);

  let restaurant = await db.restaurant.findUnique({ where: { slug: restaurantSlug } });
  if (restaurant) {
    console.log(`  restaurant       exists, reusing (${restaurant.id})`);
  } else {
    restaurant = await db.restaurant.create({
      data: {
        name: restaurantName,
        slug: restaurantSlug,
        timezone,
        phone,
        largePartyThreshold: 8,
        defaultTurnTimes: { default: 90, '1': 60, '2': 90, '5': 120, '8': 150 },
        bookingWindowDays: 90,
        flexibilityMinutes: 60,
        cancellationPolicy: 'Please give us four hours notice if you need to cancel.',
        hmacSecret,
      },
    });
    console.log(`  restaurant       created (${restaurant.id})`);
  }
  const restaurantId = restaurant.id;

  const existingAdmin = await db.adminUser.findFirst({ where: { restaurantId, email } });
  if (existingAdmin) {
    console.log(`  admin user       exists, left unchanged (${email})`);
  } else {
    await db.adminUser.create({
      data: { restaurantId, email, passwordHash: hashPassword(password), role: 'owner' },
    });
    console.log(`  admin user       created (${email})`);
  }

  let floor = await db.floor.findFirst({ where: { restaurantId, name: 'Ground' } });
  floor ??= await db.floor.create({
    data: { restaurantId, name: 'Ground', level: 0, stepFreeAccess: true },
  });

  // Pass one: create tables without combines_with, which may point at a table
  // that does not exist yet.
  const idByLabel = new Map<string, string>();
  let createdTables = 0;
  for (const [i, spec] of DEFAULT_ROOM.entries()) {
    const existing = await db.table.findFirst({ where: { restaurantId, label: spec.label } });
    if (existing) {
      idByLabel.set(spec.label, existing.id);
      continue;
    }
    const table = await db.table.create({
      data: {
        restaurantId,
        floorId: floor.id,
        label: spec.label,
        minCovers: spec.min,
        maxCovers: spec.max,
        shape: 'rectangle',
        x: (i % 4) * 100,
        y: Math.floor(i / 4) * 100,
        width: 70,
        height: 70,
        attributes: { ...fullAttributes(spec), combines_with: [] },
      },
    });
    idByLabel.set(spec.label, table.id);
    createdTables++;
  }

  // Pass two: resolve combines_with now every table has an id.
  for (const spec of DEFAULT_ROOM) {
    if (!spec.combinesWith?.length) continue;
    const id = idByLabel.get(spec.label);
    if (!id) continue;
    await db.table.update({
      where: { id },
      data: {
        attributes: {
          ...fullAttributes(spec),
          combines_with: spec.combinesWith
            .map((label) => idByLabel.get(label))
            .filter((v): v is string => Boolean(v)),
        },
      },
    });
  }
  console.log(`  tables           ${createdTables} created, ${idByLabel.size} total`);

  const periodCount = await db.servicePeriod.count({ where: { restaurantId } });
  if (periodCount > 0) {
    console.log(`  service periods  ${periodCount} exist, left unchanged`);
  } else {
    await db.servicePeriod.createMany({
      data: [
        {
          restaurantId,
          name: 'Lunch',
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          startTime: '12:00',
          endTime: '15:00',
          slotIntervalMinutes: 15,
          lastSeatingOffsetMinutes: -30,
          turnTimeOverrides: { default: 75 },
        },
        {
          restaurantId,
          name: 'Dinner',
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          startTime: '17:00',
          endTime: '23:00',
          slotIntervalMinutes: 15,
          lastSeatingOffsetMinutes: -60,
        },
      ],
    });
    console.log('  service periods  Lunch and Dinner created');
  }

  // Hours, accessibility and zones, written from the structured data above so
  // the agent can answer "do you have step free access" with no FAQ authored.
  const knowledge = new KnowledgeService({
    db,
    cache: redis(),
    embedder: buildEmbedder(),
    reranker: buildReranker(),
  });
  await knowledge.regenerateDerived(restaurantId);
  const { indexed, failed } = await knowledge.processPending(restaurantId);
  console.log(`  knowledge        ${indexed} documents indexed${failed ? `, ${failed} failed` : ''}`);

  console.log(`
  Ready.

    slug            ${restaurantSlug}
    restaurant id   ${restaurantId}
    admin login     ${email}

  Point Vonage AI Studio at this deployment with:
    X-Restaurant: ${restaurantSlug}
    signature secret: the hmacSecret you passed here

  Verify it is bookable:
    curl -sS -X POST "$BASE/v1/public/${restaurantSlug}/availability" \\
      -H 'content-type: application/json' \\
      -d '{"party_size":2,"date":"YYYY-MM-DD","time":"19:30","accessibility":[],"seating_preferences":[]}'
`);
}

main()
  .catch((error) => {
    console.error('Production seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis().quit().catch(() => undefined);
  });
