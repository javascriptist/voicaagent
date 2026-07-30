import { TableAttributesSchema, type TableAttributes, type Zone } from '../../src/domain/attributes.js';
import type {
  ClosureInput,
  FloorInput,
  OccupancyInput,
  RestaurantConfig,
  ServicePeriodInput,
  Snapshot,
  TableInput,
} from '../../src/availability/types.js';
import { localToUtcOrThrow } from '../../src/time/zone.js';

/**
 * Snapshot builders for the engine tests.
 *
 * Deliberately explicit rather than clever: every test states the room it is
 * reasoning about, so a failure points at a floor plan you can picture instead
 * of at a fixture five files away.
 */

export const LONDON = 'Europe/London';
export const NEW_YORK = 'America/New_York';

/** Stable ids, so a failing assertion prints something you can grep for. */
export function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function attrs(overrides: Partial<TableAttributes> = {}): TableAttributes {
  return TableAttributesSchema.parse({ zone: 'main', seat_type: 'chair', ...overrides });
}

export interface TableSpec {
  label: string;
  min: number;
  max: number;
  floorId?: string;
  attributes?: Partial<TableAttributes>;
  isActive?: boolean;
}

export function makeTables(specs: TableSpec[], defaultFloorId: string): TableInput[] {
  return specs.map((s, i) => ({
    id: uuid(1000 + i),
    floorId: s.floorId ?? defaultFloorId,
    label: s.label,
    minCovers: s.min,
    maxCovers: s.max,
    attributes: attrs(s.attributes),
    isActive: s.isActive ?? true,
  }));
}

export const GROUND_FLOOR: FloorInput = {
  id: uuid(1),
  name: 'Ground',
  level: 0,
  stepFreeAccess: true,
};

export const UPSTAIRS: FloorInput = {
  id: uuid(2),
  name: 'Mezzanine',
  level: 1,
  stepFreeAccess: false,
};

export const UPSTAIRS_WITH_LIFT: FloorInput = {
  id: uuid(3),
  name: 'First floor',
  level: 1,
  stepFreeAccess: true,
};

export const DINNER: ServicePeriodInput = {
  id: uuid(10),
  name: 'Dinner',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: '17:00',
  endTime: '23:00',
  slotIntervalMinutes: 15,
  lastSeatingOffsetMinutes: -60,
  turnTimeOverrides: null,
  isActive: true,
};

export const LUNCH: ServicePeriodInput = {
  id: uuid(11),
  name: 'Lunch',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: '12:00',
  endTime: '15:00',
  slotIntervalMinutes: 15,
  lastSeatingOffsetMinutes: -30,
  turnTimeOverrides: { default: 60 },
  isActive: true,
};

/** Round the clock, for tests that care about DST rather than opening hours. */
export const ALL_DAY: ServicePeriodInput = {
  id: uuid(12),
  name: 'All day',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: '00:00',
  endTime: '23:45',
  slotIntervalMinutes: 15,
  lastSeatingOffsetMinutes: 0,
  turnTimeOverrides: null,
  isActive: true,
};

export function restaurantConfig(overrides: Partial<RestaurantConfig> = {}): RestaurantConfig {
  return {
    id: uuid(100),
    timezone: LONDON,
    largePartyThreshold: 8,
    defaultTurnTimes: { default: 90, '1': 60, '2': 90, '5': 120, '9': 150 },
    bookingWindowDays: 90,
    flexibilityMinutes: 60,
    ...overrides,
  };
}

export interface SnapshotSpec {
  restaurant?: Partial<RestaurantConfig>;
  floors?: FloorInput[];
  tables?: TableInput[];
  servicePeriods?: ServicePeriodInput[];
  closures?: ClosureInput[];
  occupancy?: OccupancyInput[];
}

export function makeSnapshot(spec: SnapshotSpec = {}): Snapshot {
  const floors = spec.floors ?? [GROUND_FLOOR];
  return {
    restaurant: restaurantConfig(spec.restaurant),
    floors,
    tables:
      spec.tables ??
      makeTables(
        [
          { label: 'T1', min: 1, max: 2 },
          { label: 'T2', min: 2, max: 4 },
          { label: 'T3', min: 4, max: 6 },
        ],
        floors[0]!.id,
      ),
    servicePeriods: spec.servicePeriods ?? [DINNER],
    closures: spec.closures ?? [],
    occupancy: spec.occupancy ?? [],
  };
}

/** Local wall-clock helper so tests read in the restaurant's time, not UTC. */
export function at(date: string, time: string, zone = LONDON): Date {
  return localToUtcOrThrow(date, time, zone);
}

export function reservation(
  tableId: string,
  date: string,
  time: string,
  minutes: number,
  zone = LONDON,
): OccupancyInput {
  const startsAt = at(date, time, zone);
  return {
    tableId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    kind: 'reservation',
    reservationId: uuid(9000 + Math.floor(Math.random() * 1000)),
  };
}

export function hold(
  tableId: string,
  date: string,
  time: string,
  minutes: number,
  callId: string,
  zone = LONDON,
): OccupancyInput {
  const startsAt = at(date, time, zone);
  return {
    tableId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    kind: 'hold',
    ownerCallId: callId,
  };
}

export function block(
  tableId: string,
  date: string,
  time: string,
  minutes: number,
  zone = LONDON,
): OccupancyInput {
  const startsAt = at(date, time, zone);
  return {
    tableId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
    kind: 'block',
  };
}

export function tableByLabel(snapshot: Snapshot, label: string): TableInput {
  const t = snapshot.tables.find((x) => x.label === label);
  if (!t) throw new Error(`No table labelled ${label} in fixture`);
  return t;
}

export function labelsOf(snapshot: Snapshot, ids: string[]): string[] {
  return ids.map((i) => snapshot.tables.find((t) => t.id === i)?.label ?? i);
}

export function zoneOf(t: TableInput): Zone {
  return t.attributes.zone;
}
