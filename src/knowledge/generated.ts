import type { PrismaClient } from '@prisma/client';
import { parseAttributes, ZONES, type Zone } from '../domain/attributes.js';
import { spokenTime } from '../time/zone.js';

/**
 * Knowledge written from structured data, not from a document.
 *
 * The point: nobody should have to write an FAQ entry saying "yes, we have
 * step-free access" when the floor plan already records it. Anything the admin
 * can get wrong by typing it twice is generated from the one place it is
 * actually true, and regenerated whenever that place changes.
 *
 * Generated documents are keyed by `generationKey` and replaced in place, so
 * regeneration never accumulates duplicates. The admin API refuses to edit
 * them, because the next structural change would silently overwrite the edit.
 */

export const GENERATION_KEYS = {
  hours: 'generated:hours',
  accessibility: 'generated:accessibility',
  zones: 'generated:zones',
} as const;

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface GeneratedDocument {
  generationKey: string;
  source: 'hours' | 'layout' | 'policy';
  title: string;
  content: string;
}

export async function generateDocuments(
  db: PrismaClient,
  restaurantId: string,
): Promise<GeneratedDocument[]> {
  const [restaurant, periods, floors, tables] = await Promise.all([
    db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
    db.servicePeriod.findMany({ where: { restaurantId, isActive: true } }),
    db.floor.findMany({ where: { restaurantId }, orderBy: { level: 'asc' } }),
    db.table.findMany({ where: { restaurantId, isActive: true } }),
  ]);

  const closures = await db.closure.findMany({
    where: { restaurantId, endsAt: { gte: new Date() } },
    orderBy: { startsAt: 'asc' },
    take: 20,
  });

  return [
    hoursDocument(restaurant.name, periods, closures, restaurant.timezone),
    accessibilityDocument(restaurant.name, floors, tables),
    zonesDocument(restaurant.name, tables, floors),
  ];
}

function hoursDocument(
  name: string,
  periods: Array<{
    name: string;
    daysOfWeek: number[];
    startTime: string;
    endTime: string;
    lastSeatingOffsetMinutes: number;
  }>,
  closures: Array<{ startsAt: Date; endsAt: Date; reason: string }>,
  timezone: string,
): GeneratedDocument {
  const lines: string[] = ['# Opening hours', ''];

  if (periods.length === 0) {
    lines.push('No service times are currently configured.');
  }

  for (const period of periods) {
    const days = [...period.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAYS[d] ?? String(d));
    lines.push(
      `${period.name}: ${listDays(days)}, ${period.startTime} to ${period.endTime}. ` +
        `Said aloud, that is ${spokenTime(period.startTime)} until ${spokenTime(period.endTime)}.`,
    );
    if (period.lastSeatingOffsetMinutes < 0) {
      lines.push(
        `  The last ${period.name.toLowerCase()} booking is ${Math.abs(period.lastSeatingOffsetMinutes)} minutes before close.`,
      );
    }
  }

  if (closures.length > 0) {
    lines.push('', '## Upcoming closures', '');
    for (const closure of closures) {
      const from = closure.startsAt.toLocaleDateString('en-GB', { timeZone: timezone, dateStyle: 'full' });
      lines.push(`Closed ${from}: ${closure.reason}.`);
    }
  }

  lines.push('', `All times are local to ${name} (${timezone}).`);

  return {
    generationKey: GENERATION_KEYS.hours,
    source: 'hours',
    title: 'Opening hours',
    content: lines.join('\n'),
  };
}

/**
 * The document that lets the agent answer "do you have step free access"
 * without anyone having written an FAQ.
 */
function accessibilityDocument(
  name: string,
  floors: Array<{ id: string; name: string; level: number; stepFreeAccess: boolean }>,
  tables: Array<{ floorId: string; attributes: unknown; maxCovers: number }>,
): GeneratedDocument {
  const lines: string[] = ['# Accessibility', ''];

  const stepFreeFloors = floors.filter((f) => f.level === 0 || f.stepFreeAccess);
  if (stepFreeFloors.length > 0) {
    lines.push(
      `Yes, ${name} has step-free access. ` +
        `${listNames(stepFreeFloors.map((f) => f.name))} ${stepFreeFloors.length === 1 ? 'is' : 'are'} reachable without steps.`,
    );
  } else {
    lines.push(`${name} does not currently have step-free access to any floor.`);
  }

  const noStepFree = floors.filter((f) => f.level !== 0 && !f.stepFreeAccess);
  if (noStepFree.length > 0) {
    lines.push(
      `${listNames(noStepFree.map((f) => f.name))} ${noStepFree.length === 1 ? 'is' : 'are'} reached by stairs only.`,
    );
  }

  lines.push('', '## Per floor', '');
  for (const floor of floors) {
    const onFloor = tables.filter((t) => t.floorId === floor.id).map((t) => parseAttributes(t.attributes));
    const accessible = onFloor.filter((a) => a.is_wheelchair_accessible).length;
    const clearance = onFloor.filter((a) => a.has_wheelchair_clearance).length;
    const level =
      floor.level === 0 ? 'ground level' : floor.level > 0 ? `floor ${floor.level}` : `basement level ${-floor.level}`;

    lines.push(
      `${floor.name} (${level}): ${floor.level === 0 || floor.stepFreeAccess ? 'step-free' : 'stairs only'}, ` +
        `${onFloor.length} tables, ${accessible} wheelchair accessible, ` +
        `${clearance} with room for a wheelchair at the table.`,
    );
  }

  const quiet = tables.filter((t) => parseAttributes(t.attributes).noise_level === 'quiet').length;
  if (quiet > 0) {
    lines.push('', `There are ${quiet} quieter tables away from the speakers, which we can request for guests who need them.`);
  }

  lines.push(
    '',
    'Guests who need an accessible table should say so when booking, and we will hold one.',
  );

  return {
    generationKey: GENERATION_KEYS.accessibility,
    source: 'layout',
    title: 'Accessibility and step-free access',
    content: lines.join('\n'),
  };
}

function zonesDocument(
  name: string,
  tables: Array<{ floorId: string; attributes: unknown; minCovers: number; maxCovers: number }>,
  floors: Array<{ id: string; name: string }>,
): GeneratedDocument {
  const lines: string[] = ['# Where you can sit', ''];
  const byZone = new Map<Zone, typeof tables>();

  for (const table of tables) {
    const zone = parseAttributes(table.attributes).zone;
    byZone.set(zone, [...(byZone.get(zone) ?? []), table]);
  }

  const present = ZONES.filter((z) => byZone.has(z));
  lines.push(
    present.length > 0
      ? `${name} has ${listNames(present.map(zoneLabel))}.`
      : 'No seating areas are configured yet.',
  );
  lines.push('');

  for (const zone of present) {
    const zoneTables = byZone.get(zone)!;
    const largest = Math.max(...zoneTables.map((t) => t.maxCovers));
    const attrs = zoneTables.map((t) => parseAttributes(t.attributes));
    const floorNames = [
      ...new Set(zoneTables.map((t) => floors.find((f) => f.id === t.floorId)?.name ?? 'unknown')),
    ];
    const features: string[] = [];
    if (attrs.some((a) => a.seat_type === 'booth')) features.push('booths');
    if (attrs.some((a) => a.seat_type === 'banquette')) features.push('banquettes');
    if (attrs.some((a) => a.near_window)) features.push('window tables');
    if (attrs.some((a) => a.noise_level === 'quiet')) features.push('quieter tables');
    if (attrs.some((a) => a.is_combinable)) features.push('tables that can be pushed together for larger parties');

    lines.push(
      `${zoneLabel(zone)}: ${zoneTables.length} tables on ${listNames(floorNames)}, ` +
        `largest seats ${largest}.` +
        (features.length > 0 ? ` Has ${listNames(features)}.` : ''),
    );
  }

  return {
    generationKey: GENERATION_KEYS.zones,
    source: 'layout',
    title: 'Seating areas',
    content: lines.join('\n'),
  };
}

function zoneLabel(zone: Zone): string {
  switch (zone) {
    case 'main':
      return 'a main dining room';
    case 'terrace':
      return 'a terrace';
    case 'bar':
      return 'bar seating';
    case 'private':
      return 'a private dining room';
    case 'mezzanine':
      return 'a mezzanine';
  }
}

function listDays(days: string[]): string {
  if (days.length === 7) return 'every day';
  return listNames(days);
}

function listNames(items: string[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
