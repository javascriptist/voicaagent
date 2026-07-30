import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/http/routes/admin.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { buildEmbedder, buildReranker } from '../src/knowledge/embedder.js';
import { redis } from '../src/lib/redis.js';
import type { TableAttributes, Zone } from '../src/domain/attributes.js';

/**
 * The demo restaurant.
 *
 * One restaurant, seeded end to end: two floors, twenty tables of deliberately
 * mixed attributes, two service periods, and enough knowledge to answer a real
 * call. The floor plan is designed so every interesting engine path has
 * something to find — combinable runs for large parties, a genuinely
 * inaccessible upstairs, quiet tables, a terrace.
 *
 * Idempotent: re-running updates the demo restaurant in place rather than
 * creating a second one.
 */

const db = new PrismaClient();

const SLUG = 'the-tasting-room';
const TIMEZONE = 'Europe/London';

function attrs(overrides: Partial<TableAttributes> & { zone: Zone }): TableAttributes {
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
    ...overrides,
  };
}

interface TableSpec {
  label: string;
  floor: 'ground' | 'mezzanine';
  min: number;
  max: number;
  shape: 'round' | 'square' | 'rectangle' | 'oval';
  x: number;
  y: number;
  w: number;
  h: number;
  attributes: TableAttributes;
  /** Labels of tables this one can be pushed against. */
  combinesWith?: string[];
}

const TABLES: TableSpec[] = [
  // --- Ground floor, main room -------------------------------------------
  // A run of four two-tops along the window that combine into larger parties.
  { label: 'W1', floor: 'ground', min: 1, max: 2, shape: 'square', x: 40, y: 40, w: 60, h: 60,
    attributes: attrs({ zone: 'main', near_window: true, seat_type: 'banquette', is_combinable: true, noise_level: 'quiet' }),
    combinesWith: ['W2'] },
  { label: 'W2', floor: 'ground', min: 1, max: 2, shape: 'square', x: 40, y: 120, w: 60, h: 60,
    attributes: attrs({ zone: 'main', near_window: true, seat_type: 'banquette', is_combinable: true, noise_level: 'quiet' }),
    combinesWith: ['W1', 'W3'] },
  { label: 'W3', floor: 'ground', min: 2, max: 4, shape: 'rectangle', x: 40, y: 200, w: 60, h: 90,
    attributes: attrs({ zone: 'main', near_window: true, is_combinable: true }),
    combinesWith: ['W2', 'W4'] },
  { label: 'W4', floor: 'ground', min: 2, max: 4, shape: 'rectangle', x: 40, y: 310, w: 60, h: 90,
    attributes: attrs({ zone: 'main', near_window: true, is_combinable: true }),
    combinesWith: ['W3'] },

  // Booths down the middle. Fixed seating, so no wheelchair transfer.
  { label: 'B1', floor: 'ground', min: 2, max: 4, shape: 'rectangle', x: 160, y: 60, w: 80, h: 90,
    attributes: attrs({ zone: 'main', seat_type: 'booth', noise_level: 'quiet' }) },
  { label: 'B2', floor: 'ground', min: 2, max: 4, shape: 'rectangle', x: 160, y: 170, w: 80, h: 90,
    attributes: attrs({ zone: 'main', seat_type: 'booth', noise_level: 'quiet' }) },
  { label: 'B3', floor: 'ground', min: 4, max: 6, shape: 'rectangle', x: 160, y: 280, w: 80, h: 120,
    attributes: attrs({ zone: 'main', seat_type: 'booth' }) },

  // Accessible tables: step-free floor, room for a chair, movable seating.
  { label: 'A1', floor: 'ground', min: 1, max: 4, shape: 'round', x: 300, y: 60, w: 90, h: 90,
    attributes: attrs({ zone: 'main', is_wheelchair_accessible: true, has_wheelchair_clearance: true, near_entrance: true }) },
  { label: 'A2', floor: 'ground', min: 2, max: 6, shape: 'round', x: 300, y: 180, w: 110, h: 110,
    attributes: attrs({ zone: 'main', is_wheelchair_accessible: true, has_wheelchair_clearance: true }) },

  // Near the kitchen and the toilets: useful, but nobody's first choice.
  { label: 'K1', floor: 'ground', min: 2, max: 4, shape: 'square', x: 300, y: 320, w: 70, h: 70,
    attributes: attrs({ zone: 'main', near_kitchen: true, noise_level: 'loud' }) },
  { label: 'T1', floor: 'ground', min: 2, max: 4, shape: 'square', x: 300, y: 410, w: 70, h: 70,
    attributes: attrs({ zone: 'main', near_toilets: true }) },

  // --- Ground floor, bar --------------------------------------------------
  { label: 'BAR1', floor: 'ground', min: 1, max: 2, shape: 'round', x: 440, y: 60, w: 50, h: 50,
    attributes: attrs({ zone: 'bar', seat_type: 'high_stool', near_speakers: true, noise_level: 'loud' }) },
  { label: 'BAR2', floor: 'ground', min: 1, max: 2, shape: 'round', x: 440, y: 130, w: 50, h: 50,
    attributes: attrs({ zone: 'bar', seat_type: 'high_stool', near_speakers: true, noise_level: 'loud' }) },
  { label: 'BAR3', floor: 'ground', min: 1, max: 3, shape: 'round', x: 440, y: 200, w: 50, h: 50,
    attributes: attrs({ zone: 'bar', seat_type: 'high_stool', noise_level: 'loud' }) },

  // --- Ground floor, terrace ---------------------------------------------
  // A combinable run outdoors, for the large summer bookings.
  { label: 'TR1', floor: 'ground', min: 2, max: 4, shape: 'square', x: 560, y: 60, w: 70, h: 70,
    attributes: attrs({ zone: 'terrace', is_combinable: true, near_window: true }),
    combinesWith: ['TR2'] },
  { label: 'TR2', floor: 'ground', min: 2, max: 4, shape: 'square', x: 560, y: 150, w: 70, h: 70,
    attributes: attrs({ zone: 'terrace', is_combinable: true }),
    combinesWith: ['TR1', 'TR3'] },
  { label: 'TR3', floor: 'ground', min: 2, max: 6, shape: 'rectangle', x: 560, y: 240, w: 70, h: 100,
    attributes: attrs({ zone: 'terrace', is_combinable: true, is_wheelchair_accessible: true, has_wheelchair_clearance: true }),
    combinesWith: ['TR2'] },

  // --- Mezzanine: stairs only, so never step-free ------------------------
  { label: 'M1', floor: 'mezzanine', min: 2, max: 4, shape: 'round', x: 60, y: 60, w: 80, h: 80,
    attributes: attrs({ zone: 'mezzanine', noise_level: 'quiet', near_window: true }) },
  { label: 'M2', floor: 'mezzanine', min: 2, max: 4, shape: 'round', x: 170, y: 60, w: 80, h: 80,
    attributes: attrs({ zone: 'mezzanine', noise_level: 'quiet' }) },

  // --- Private dining room ------------------------------------------------
  { label: 'PDR', floor: 'mezzanine', min: 8, max: 14, shape: 'oval', x: 60, y: 200, w: 220, h: 110,
    attributes: attrs({ zone: 'private', noise_level: 'quiet' }) },
];

const KNOWLEDGE: Array<{ source: 'policy' | 'menu' | 'faq' | 'layout'; title: string; content: string }> = [
  {
    source: 'policy',
    title: 'Booking and cancellation policy',
    content: `# Cancellations
We ask for at least four hours' notice if you need to cancel. You can cancel by
phone or by replying to your confirmation text. There is no charge for cancelling
a standard table at any notice, though we would always rather know.

# Late arrivals
We hold tables for fifteen minutes past the booking time. After that we may need
to release the table, especially at the weekend. Please ring if you are running
late and we will do what we can.

# Deposits
Parties of eight or more are asked for a deposit of ten pounds per person, taken
by card over the phone. The deposit comes off the final bill. It is refundable
with forty-eight hours' notice.

# No shows
A no show on a party of eight or more forfeits the deposit. We do not charge for
smaller no shows, but repeated no shows may mean we ask for a card next time.

# Large parties
Parties of eight or more are handled by our reservations team rather than booked
automatically, because they usually involve a set menu and a deposit.`,
  },
  {
    source: 'policy',
    title: 'Accessibility policy',
    content: `# Wheelchair access
The ground floor is entirely step-free, including the terrace, and there is an
accessible toilet on the ground floor. Please tell us when booking if you need a
table with space for a wheelchair, and we will hold one of our accessible tables.

# The mezzanine
The mezzanine and the private dining room are reached by a flight of twelve
stairs and there is no lift. We cannot offer step-free access to those areas.

# Assistance dogs
Assistance dogs are welcome everywhere in the building, including the terrace.
We will seat you at a table with floor space beside it and bring a water bowl.

# Hearing and sensory needs
We have quieter tables away from the speakers, in the booths and along the
window. Ask for a quiet table when you book and we will do our best. We can turn
the music down in the private dining room on request.

# Dietary and allergy handling
Tell us any allergies when you book and we will pass them to the kitchen exactly
as you describe them. Please also tell your server on arrival, so it is on the
ticket as well as on the booking.`,
  },
  {
    source: 'faq',
    title: 'Frequently asked questions',
    content: `# Do you have parking
We do not have a car park. There is a pay and display car park two streets away
on Mill Lane, free after six in the evening.

# Are dogs allowed
Well behaved dogs are welcome on the terrace and at the bar. Assistance dogs are
welcome throughout the building.

# Do you have high chairs
Yes, we have four high chairs. Mention it when booking so we can put one by your
table.

# Is there a children's menu
We do not have a separate children's menu, but the kitchen will happily do
smaller portions of most main courses.

# Do you cater for vegans
Yes. There are vegan options in every course and the kitchen can adapt several
more. Tell us when booking and the chef will have something ready.

# Is there a dress code
No dress code. Come as you are.

# Can we bring our own wine
Corkage is fifteen pounds a bottle, two bottles maximum per table.

# Do you take walk ins
Yes, at the bar and on the terrace. The dining room is usually booked out at the
weekend, so ring ahead if you can.

# What time is last orders
The kitchen closes an hour before we do. Last dinner bookings are at ten in the
evening and last lunch bookings at half past two.

# Do you do gift vouchers
Yes, in any amount, valid for a year. Ask any member of the team or ring us.

# Can we hire the whole restaurant
Yes, for parties of forty or more. Our events team will talk you through it.

# Is there wifi
Yes, the network is called Tasting Room Guest and the password is on the menu.

# Do you have a set menu
There is a three course set menu at lunch on weekdays, and a tasting menu on
Friday and Saturday evenings.

# Can I book the private dining room
The private dining room seats up to fourteen and is upstairs. It is bookable for
lunch and dinner with a minimum spend at the weekend.

# What is the nearest station
The station is a seven minute walk, straight up the high street and left at the
church.`,
  },
  {
    source: 'menu',
    title: 'Menu',
    content: `# Starters
Cured sea trout, cucumber, dill and horseradish cream. Contains fish and dairy.
Heritage tomato salad with basil and aged sherry vinegar. Vegan.
Chicken liver parfait, sourdough toast, spiced pear chutney. Contains dairy and gluten.
Roast cauliflower, almond, golden raisin and brown butter. Contains nuts and dairy.
Soup of the day, always vegetarian, usually vegan. Ask your server.

# Main courses
Aged sirloin, triple cooked chips, watercress and peppercorn sauce. Contains dairy.
Whole roast plaice, brown shrimp, capers and parsley butter. Contains fish, shellfish and dairy.
Wild mushroom and barley risotto, aged hard cheese. Vegetarian, can be made vegan.
Free range chicken, creamed leeks, tarragon. Contains dairy.
Slow cooked lamb shoulder for two to share, rosemary and anchovy.

# Puddings
Sticky toffee pudding, salted caramel, clotted cream. Contains dairy, gluten and eggs.
Dark chocolate delice, olive oil, sea salt. Contains dairy and eggs.
Seasonal fruit crumble with custard or ice cream. Contains dairy and gluten.
British cheese board, quince, oatcakes. Contains dairy and gluten.

# Set lunch
Two courses for twenty two pounds, three for twenty eight, Tuesday to Friday.

# Tasting menu
Seven courses, served Friday and Saturday evening, for the whole table. Vegetarian
and vegan versions available with notice. Wine pairing optional.

# Allergen note
Our kitchen handles nuts, gluten, dairy, eggs, fish and shellfish. We cannot
guarantee any dish is entirely free of a given allergen, but we will always tell
you exactly what is in a dish and the chef will adapt where possible.`,
  },
  {
    source: 'layout',
    title: 'The rooms',
    content: `# The main dining room
The main room is on the ground floor and seats around forty. It has a run of
banquette tables along the window, three booths down the middle, and round
tables towards the back. It is the quietest part of the restaurant on a weekday
and the busiest on a Saturday.

# The bar
Three high stool tables at the bar, walk ins only in practice though we can book
them. The speakers are above the bar, so it is the loudest part of the room.

# The terrace
Covered and heated, open all year. Three tables that can be pushed together for
larger parties. Step-free from the street and from the dining room.

# The mezzanine
Two quiet tables overlooking the dining room, up twelve stairs. No lift, so not
step-free.

# The private dining room
Upstairs next to the mezzanine, seats eight to fourteen around one oval table.
Its own sound system and a door that closes.`,
  },
];

async function main(): Promise<void> {
  console.log('Seeding the demo restaurant...');

  const hmacSecret = process.env.DEMO_HMAC_SECRET ?? 'demo-secret-change-me-in-production';

  const restaurant = await db.restaurant.upsert({
    where: { slug: SLUG },
    update: {
      name: 'The Tasting Room',
      timezone: TIMEZONE,
      phone: '+441234567890',
      largePartyThreshold: 8,
      defaultTurnTimes: { default: 90, '1': 60, '2': 90, '5': 120, '8': 150 },
      bookingWindowDays: 90,
      flexibilityMinutes: 60,
      cancellationPolicy: "Free to cancel with four hours' notice.",
      hmacSecret,
    },
    create: {
      name: 'The Tasting Room',
      slug: SLUG,
      timezone: TIMEZONE,
      phone: '+441234567890',
      largePartyThreshold: 8,
      defaultTurnTimes: { default: 90, '1': 60, '2': 90, '5': 120, '8': 150 },
      bookingWindowDays: 90,
      flexibilityMinutes: 60,
      cancellationPolicy: "Free to cancel with four hours' notice.",
      hmacSecret,
    },
  });
  const restaurantId = restaurant.id;

  // Wipe the parts we fully own, so re-seeding is deterministic. Reservations
  // and guests are left alone: they may be demo bookings someone is mid-test on.
  await db.knowledgeChunk.deleteMany({ where: { restaurantId } });
  await db.knowledgeDocument.deleteMany({ where: { restaurantId } });
  await db.tableBlock.deleteMany({ where: { restaurantId } });
  await db.closure.deleteMany({ where: { restaurantId } });
  await db.servicePeriod.deleteMany({ where: { restaurantId } });

  const ground = await db.floor.upsert({
    where: { restaurantId_name: { restaurantId, name: 'Ground floor' } },
    update: { level: 0, stepFreeAccess: true },
    create: { restaurantId, name: 'Ground floor', level: 0, stepFreeAccess: true },
  });
  const mezzanine = await db.floor.upsert({
    where: { restaurantId_name: { restaurantId, name: 'Mezzanine' } },
    update: { level: 1, stepFreeAccess: false },
    // Twelve stairs and no lift. This is what makes the accessibility filter
    // do real work in the demo rather than passing everything.
    create: { restaurantId, name: 'Mezzanine', level: 1, stepFreeAccess: false },
  });

  // Pass one: create every table without combines_with.
  const idByLabel = new Map<string, string>();
  for (const spec of TABLES) {
    const floorId = spec.floor === 'ground' ? ground.id : mezzanine.id;
    const table = await db.table.upsert({
      where: { restaurantId_label: { restaurantId, label: spec.label } },
      update: {
        floorId,
        minCovers: spec.min,
        maxCovers: spec.max,
        shape: spec.shape,
        x: spec.x, y: spec.y, width: spec.w, height: spec.h,
        attributes: { ...spec.attributes, combines_with: [] },
        isActive: true,
      },
      create: {
        restaurantId, floorId, label: spec.label,
        minCovers: spec.min, maxCovers: spec.max, shape: spec.shape,
        x: spec.x, y: spec.y, width: spec.w, height: spec.h,
        attributes: { ...spec.attributes, combines_with: [] },
      },
    });
    idByLabel.set(spec.label, table.id);
  }

  // Pass two: resolve combines_with now every table has an id.
  for (const spec of TABLES) {
    if (!spec.combinesWith?.length) continue;
    const combines = spec.combinesWith
      .map((label) => idByLabel.get(label))
      .filter((id): id is string => Boolean(id));
    await db.table.update({
      where: { id: idByLabel.get(spec.label)! },
      data: { attributes: { ...spec.attributes, combines_with: combines } },
    });
  }

  await db.servicePeriod.createMany({
    data: [
      {
        restaurantId,
        name: 'Lunch',
        daysOfWeek: [2, 3, 4, 5, 6, 7],
        startTime: '12:00',
        endTime: '15:00',
        slotIntervalMinutes: 15,
        lastSeatingOffsetMinutes: -30,
        // Lunch turns faster across the board.
        turnTimeOverrides: { default: 75 },
      },
      {
        restaurantId,
        name: 'Dinner',
        daysOfWeek: [2, 3, 4, 5, 6, 7],
        startTime: '17:30',
        endTime: '23:00',
        slotIntervalMinutes: 15,
        lastSeatingOffsetMinutes: -60,
        // Dinner inherits the restaurant's turn times unchanged.
      },
    ],
  });

  // A closure and a maintenance block, so the demo has something to trip over.
  const boxingDay = new Date(Date.UTC(new Date().getUTCFullYear(), 11, 26, 0, 0, 0));
  await db.closure.create({
    data: {
      restaurantId,
      startsAt: boxingDay,
      endsAt: new Date(boxingDay.getTime() + 2 * 24 * 3600 * 1000),
      reason: 'Christmas closure',
    },
  });

  await db.adminUser.upsert({
    where: { restaurantId_email: { restaurantId, email: 'owner@tastingroom.test' } },
    update: {},
    create: {
      restaurantId,
      email: 'owner@tastingroom.test',
      passwordHash: hashPassword('demo-password-1234'),
      role: 'owner',
    },
  });

  for (const doc of KNOWLEDGE) {
    await db.knowledgeDocument.create({
      data: { restaurantId, source: doc.source, title: doc.title, content: doc.content },
    });
  }

  // Generate the hours / accessibility / zones documents from the structured
  // data just written, then chunk and embed everything.
  const knowledge = new KnowledgeService({
    db,
    cache: redis(),
    embedder: buildEmbedder(),
    reranker: buildReranker(),
  });
  await knowledge.regenerateDerived(restaurantId);
  const { indexed, failed } = await knowledge.processPending(restaurantId);

  const chunkCount = await db.knowledgeChunk.count({ where: { restaurantId } });
  const tableCount = await db.table.count({ where: { restaurantId } });

  console.log(`
  Demo restaurant seeded.

    restaurant     ${restaurant.name} (${SLUG})
    id             ${restaurantId}
    timezone       ${TIMEZONE}
    floors         2 (ground floor step-free, mezzanine stairs only)
    tables         ${tableCount}
    periods        Lunch and Dinner, Tuesday to Sunday
    documents      ${indexed} indexed, ${failed} failed
    chunks         ${chunkCount}

    admin login    owner@tastingroom.test / demo-password-1234
    hmac secret    ${hmacSecret}

  Try it:
    curl -s localhost:3000/v1/public/${SLUG} | jq
`);

  if (chunkCount < 40) {
    console.warn(`  Note: ${chunkCount} chunks, fewer than the 40 the spec asks for.`);
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis().quit().catch(() => undefined);
  });

export { randomUUID };
