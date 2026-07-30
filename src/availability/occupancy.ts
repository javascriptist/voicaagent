import { overlaps } from '../time/zone.js';
import type { OccupancyInput } from './types.js';

export interface OccupancyFilter {
  /** Holds owned by this call are treated as free. */
  callId?: string | null;
  /** This reservation's own occupancy is treated as free (modify flow). */
  excludeReservationId?: string | null;
}

/**
 * Occupancy grouped by table, so checking a slot is a scan of one table's
 * intervals rather than the whole restaurant's.
 *
 * Built once per query. For a busy Saturday this is a few hundred entries, so
 * an index plus a linear scan per table beats anything cleverer and keeps the
 * engine allocation-light — the p95 budget is 500 ms for the whole HTTP round
 * trip, and this part should cost microseconds.
 */
export class OccupancyIndex {
  private readonly byTable = new Map<string, OccupancyInput[]>();

  constructor(entries: readonly OccupancyInput[]) {
    for (const e of entries) {
      const list = this.byTable.get(e.tableId);
      if (list) list.push(e);
      else this.byTable.set(e.tableId, [e]);
    }
    for (const list of this.byTable.values()) {
      list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    }
  }

  /**
   * Is this table free for [startsAt, endsAt)?
   *
   * Half-open on purpose: a booking that ends at 20:00 does not conflict with
   * one that starts at 20:00. That is what "the table turns" means, and it
   * matches the tstzrange '[)' in the exclusion constraint exactly — the
   * engine and the database must agree on the boundary or the engine will
   * offer slots the database then rejects.
   */
  isFree(tableId: string, startsAt: Date, endsAt: Date, filter: OccupancyFilter = {}): boolean {
    const list = this.byTable.get(tableId);
    if (!list) return true;
    for (const e of list) {
      if (this.ignored(e, filter)) continue;
      if (overlaps(startsAt, endsAt, e.startsAt, e.endsAt)) return false;
    }
    return true;
  }

  /** What is in the way, for diagnostics. */
  conflicts(
    tableId: string,
    startsAt: Date,
    endsAt: Date,
    filter: OccupancyFilter = {},
  ): OccupancyInput[] {
    const list = this.byTable.get(tableId);
    if (!list) return [];
    return list.filter(
      (e) => !this.ignored(e, filter) && overlaps(startsAt, endsAt, e.startsAt, e.endsAt),
    );
  }

  private ignored(e: OccupancyInput, filter: OccupancyFilter): boolean {
    if (e.kind === 'hold' && filter.callId && e.ownerCallId === filter.callId) return true;
    if (
      e.kind === 'reservation' &&
      filter.excludeReservationId &&
      e.reservationId === filter.excludeReservationId
    ) {
      return true;
    }
    return false;
  }
}
