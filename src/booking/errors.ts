/**
 * Recognising the two Postgres errors that carry meaning for us.
 *
 * Prisma does not map exclusion constraint violations to a stable code, so the
 * raw SQLSTATE and the constraint name are both checked. Getting this wrong
 * turns "that table has just gone, let me find another" into a 500 and a
 * caller listening to silence.
 */

function stringify(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { message?: string; meta?: unknown; code?: string };
  return [e.code, e.message, JSON.stringify(e.meta ?? {})].filter(Boolean).join(' ');
}

/** SQLSTATE 23P01 — our reservation_tables_no_overlap exclusion constraint. */
export function isExclusionViolation(error: unknown): boolean {
  const text = stringify(error);
  return text.includes('23P01') || text.includes('reservation_tables_no_overlap');
}

/** SQLSTATE 23505 — Prisma surfaces this as P2002. */
export function isUniqueViolation(error: unknown): boolean {
  const text = stringify(error);
  return text.includes('P2002') || text.includes('23505');
}

/** SQLSTATE 40001 / 40P01 — serialisation failure or deadlock, safe to retry. */
export function isRetryableTransactionError(error: unknown): boolean {
  const text = stringify(error);
  return text.includes('40001') || text.includes('40P01');
}
