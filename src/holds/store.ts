import type { Redis } from 'ioredis';
import type { OccupancyInput } from '../availability/types.js';

/**
 * Table holds.
 *
 * A hold stops two callers being *offered* the same table in the ninety
 * seconds between "seven thirty works" and "yes please, book it". It is an
 * optimisation for the conversation, not a correctness mechanism: the
 * exclusion constraint in Postgres is what makes double booking impossible.
 * If Redis is down, every method here degrades to a no-op and bookings still
 * cannot collide — callers just hear "that has just gone" slightly more often.
 *
 * Key shape is `hold:{restaurant}:{table}:{slot}` per spec, where slot is the
 * start instant in epoch milliseconds. The value is the call id, so a caller
 * re-checking availability is not blocked by their own hold and a hold can be
 * released only by the call that took it.
 */

export interface HoldRecord {
  restaurantId: string;
  tableId: string;
  startsAt: Date;
  endsAt: Date;
  callId: string;
}

export const HOLD_KEY_PREFIX = 'hold';

export function holdKey(restaurantId: string, tableId: string, startsAt: Date): string {
  return `${HOLD_KEY_PREFIX}:${restaurantId}:${tableId}:${startsAt.getTime()}`;
}

/**
 * Stored alongside the call id so a hold can be turned back into occupancy
 * without a second lookup. Kept as a compact delimited string rather than JSON
 * because it is read on every availability query.
 */
function encode(record: HoldRecord): string {
  return `${record.callId}|${record.startsAt.getTime()}|${record.endsAt.getTime()}`;
}

function decode(key: string, value: string): HoldRecord | null {
  const parts = value.split('|');
  const keyParts = key.split(':');
  if (parts.length !== 3 || keyParts.length !== 4) return null;
  const [callId, startMs, endMs] = parts as [string, string, string];
  const [, restaurantId, tableId] = keyParts as [string, string, string, string];
  const startsAt = new Date(Number(startMs));
  const endsAt = new Date(Number(endMs));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  return { restaurantId, tableId, startsAt, endsAt, callId };
}

export class HoldStore {
  constructor(
    private readonly client: Redis,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * Take holds on every table of an assignment, all or nothing.
   *
   * NX so an existing hold is never stolen. If any table in a combination is
   * already held, the ones already taken are released — a party of nine
   * holding two of the three tables they need is worse than holding none,
   * because it blocks another caller without being bookable itself.
   */
  async acquire(records: HoldRecord[]): Promise<boolean> {
    if (records.length === 0) return true;
    const taken: string[] = [];
    try {
      for (const record of records) {
        const key = holdKey(record.restaurantId, record.tableId, record.startsAt);
        const result = await this.client.set(key, encode(record), 'EX', this.ttlSeconds, 'NX');
        if (result !== 'OK') {
          await this.releaseKeys(taken, record.callId);
          return false;
        }
        taken.push(key);
      }
      return true;
    } catch {
      // Redis unavailable. Let the booking proceed; the database constraint
      // still prevents a collision.
      await this.releaseKeys(taken, records[0]!.callId).catch(() => undefined);
      return true;
    }
  }

  /** Every live hold for a restaurant, as engine occupancy. */
  async list(restaurantId: string): Promise<OccupancyInput[]> {
    const pattern = `${HOLD_KEY_PREFIX}:${restaurantId}:*`;
    const out: OccupancyInput[] = [];
    try {
      const keys = await this.scan(pattern);
      if (keys.length === 0) return out;
      const values = await this.client.mget(keys);
      for (const [i, key] of keys.entries()) {
        const value = values[i];
        if (!value) continue;
        const record = decode(key, value);
        if (!record) continue;
        out.push({
          tableId: record.tableId,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          kind: 'hold',
          ownerCallId: record.callId,
        });
      }
    } catch {
      // Treat an unreachable Redis as "no holds". Availability may offer a
      // table another caller is mid-way through taking, and the database will
      // reject the loser at write time.
      return [];
    }
    return out;
  }

  /** Is this exact hold still live and owned by this call? */
  async isHeldBy(
    restaurantId: string,
    tableId: string,
    startsAt: Date,
    callId: string,
  ): Promise<boolean> {
    try {
      const value = await this.client.get(holdKey(restaurantId, tableId, startsAt));
      if (!value) return false;
      return value.split('|')[0] === callId;
    } catch {
      return false;
    }
  }

  /**
   * Release holds, but only the ones this call owns.
   *
   * Compare-and-delete via Lua: a plain DEL would let a late release from an
   * expired call wipe the hold a different caller has since taken on the same
   * table.
   */
  async release(records: Array<Pick<HoldRecord, 'restaurantId' | 'tableId' | 'startsAt'>>, callId: string): Promise<void> {
    const keys = records.map((r) => holdKey(r.restaurantId, r.tableId, r.startsAt));
    await this.releaseKeys(keys, callId);
  }

  private async releaseKeys(keys: string[], callId: string): Promise<void> {
    if (keys.length === 0) return;
    const script = `
      local removed = 0
      for i, key in ipairs(KEYS) do
        local value = redis.call('GET', key)
        if value then
          local owner = string.match(value, '^[^|]*')
          if owner == ARGV[1] then
            redis.call('DEL', key)
            removed = removed + 1
          end
        end
      end
      return removed
    `;
    try {
      await this.client.eval(script, keys.length, ...keys, callId);
    } catch {
      // Nothing to do: the holds expire on their own within the TTL.
    }
  }

  /** SCAN rather than KEYS: KEYS blocks the whole Redis for large keyspaces. */
  private async scan(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }
}
