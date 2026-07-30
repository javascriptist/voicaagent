import type { TableAttributes, Zone } from '../domain/attributes.js';
import type { AccessibilityRequirement } from '../domain/accessibility.js';
import type { SeatingPreference } from '../domain/preferences.js';
import type { LocalDate, LocalTime } from '../time/zone.js';

/**
 * Inputs and outputs for the availability engine.
 *
 * Everything the engine needs arrives in a `Snapshot`. It reads no database,
 * no clock, no Redis, no network — `now` is a parameter. That is what makes
 * the hard cases (DST gaps, combination search, the accessibility filter)
 * testable without standing up Postgres, and it is what keeps the p95 budget
 * honest: the only cost in here is CPU over a few hundred rows.
 */

/**
 * Turn times in minutes, keyed by party size as a string, with a "default".
 *
 *   { "default": 90, "1": 60, "2": 90, "5": 120, "8": 150 }
 *
 * Lookup brackets downwards, see resolveTurnTime.
 */
export type TurnTimeMap = Record<string, number>;

export interface RestaurantConfig {
  id: string;
  timezone: string;
  largePartyThreshold: number;
  defaultTurnTimes: TurnTimeMap;
  bookingWindowDays: number;
  /** How far either side of the requested time to look for alternatives. */
  flexibilityMinutes: number;
}

export interface FloorInput {
  id: string;
  name: string;
  level: number;
  stepFreeAccess: boolean;
}

export interface TableInput {
  id: string;
  floorId: string;
  label: string;
  minCovers: number;
  maxCovers: number;
  attributes: TableAttributes;
  isActive: boolean;
}

export interface ServicePeriodInput {
  id: string;
  name: string;
  /** ISO weekdays, 1 Monday .. 7 Sunday, in restaurant local time. */
  daysOfWeek: number[];
  startTime: LocalTime;
  /** May be earlier than startTime, meaning the service runs past midnight. */
  endTime: LocalTime;
  slotIntervalMinutes: number;
  /** Added to endTime to get the last bookable slot. Usually negative. */
  lastSeatingOffsetMinutes: number;
  turnTimeOverrides?: TurnTimeMap | null;
  isActive: boolean;
}

export interface ClosureInput {
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

/**
 * Anything that makes a table unusable for a window.
 *
 * Reservations, maintenance blocks and live Redis holds are all the same fact
 * to the engine — the table is not free — so they arrive in one list. Holds
 * carry the call that owns them so a caller re-checking availability mid-call
 * is not blocked by their own hold.
 */
export interface OccupancyInput {
  tableId: string;
  startsAt: Date;
  endsAt: Date;
  kind: 'reservation' | 'hold' | 'block';
  /** Set on holds. */
  ownerCallId?: string | null;
  /** Set on reservations, so a modify can ignore the booking being moved. */
  reservationId?: string | null;
}

export interface Snapshot {
  restaurant: RestaurantConfig;
  floors: FloorInput[];
  tables: TableInput[];
  servicePeriods: ServicePeriodInput[];
  closures: ClosureInput[];
  occupancy: OccupancyInput[];
}

export interface AvailabilityQuery {
  partySize: number;
  /** Requested wall-clock time in the restaurant's zone. */
  date: LocalDate;
  time: LocalTime;
  accessibility: AccessibilityRequirement[];
  seatingPreferences: SeatingPreference[];
  /** Overrides the restaurant default. */
  flexibilityMinutes?: number;
  now: Date;
  /** Holds owned by this call do not count as busy. */
  callId?: string | null;
  /** Reservation being modified; its occupancy is ignored. */
  excludeReservationId?: string | null;
  maxAlternatives?: number;
  nextDateCount?: number;
}

export interface ScoreBreakdown {
  preferenceMatch: number;
  capacityWaste: number;
  zoneBalance: number;
  accessibilityReserve: number;
  total: number;
}

export interface TableAssignment {
  tableIds: string[];
  labels: string[];
  floorId: string;
  zone: Zone;
  /** Total maxCovers across the assigned tables. */
  seats: number;
  isCombination: boolean;
  matchedPreferences: SeatingPreference[];
  unmatchedPreferences: SeatingPreference[];
  score: number;
  breakdown: ScoreBreakdown;
}

export interface SlotOption {
  startsAt: Date;
  endsAt: Date;
  localDate: LocalDate;
  localTime: LocalTime;
  servicePeriodId: string;
  servicePeriodName: string;
  turnTimeMinutes: number;
  assignment: TableAssignment;
  /** Signed minutes from the requested time. 0 for the requested slot itself. */
  deltaMinutes: number;
}

export type UnavailableReason =
  /** Beyond booking_window_days. */
  | 'outside_booking_window'
  /** The requested time has already passed. */
  | 'in_the_past'
  /** A closure covers the requested window. */
  | 'closed'
  /** The restaurant is not serving then. */
  | 'not_a_service_time'
  /** Spring forward: that wall-clock time does not exist on that date. */
  | 'nonexistent_local_time'
  /** No table or combination in the building is big enough, ever. */
  | 'party_too_large'
  /** Party is at or over large_party_threshold; hand to a human. */
  | 'large_party_referral'
  /** Tables exist and are the right size, but none is free then. */
  | 'fully_booked'
  /** Free tables exist but none meets the accessibility requirements. */
  | 'no_accessible_table';

export interface AvailabilityResult {
  available: boolean;
  requested: {
    localDate: LocalDate;
    localTime: LocalTime;
    startsAt: Date | null;
    endsAt: Date | null;
    partySize: number;
  };
  turnTimeMinutes: number;
  /** Best table or combination at the requested time. Null when unavailable. */
  offer: SlotOption | null;
  /** Other times on the same day within flexibilityMinutes, nearest first. */
  alternatives: SlotOption[];
  /** The next dates that have space, for when the requested day is a write-off. */
  nextDates: SlotOption[];
  reason: UnavailableReason | null;
  /**
   * Party is at or above the restaurant's large_party_threshold. Not a
   * refusal — the booking may still be offered — but the caller should be
   * handed to a human for deposits, set menus and the rest.
   */
  largeParty: boolean;
}
