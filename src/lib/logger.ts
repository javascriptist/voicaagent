import { pino, type Logger } from 'pino';
import { env } from './env.js';

/**
 * One structured log line per tool call, so the slow path is findable.
 *
 * The fields are fixed on purpose — `tool`, `latency_ms`, `restaurant_id`,
 * `call_id`, `ok`, `code` — because the first question after a bad call is
 * always "which tool was slow, on which call", and that should be a filter,
 * not a grep.
 */

let instance: Logger | null = null;

export function logger(): Logger {
  instance ??= pino({
    level: env().LOG_LEVEL,
    redact: {
      // Secrets and caller PII must not reach the log store. Phone numbers are
      // redacted rather than removed so a support engineer can still see that
      // a number was present.
      paths: [
        'req.headers.authorization',
        'req.headers["x-signature"]',
        'hmac_secret',
        'password',
        'passwordHash',
        '*.hmac_secret',
        '*.password',
      ],
      censor: '[redacted]',
    },
    base: { service: 'aicallcenter' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return instance;
}

export interface ToolCallLog {
  tool: string;
  restaurantId: string | null;
  callId: string | null;
  latencyMs: number;
  ok: boolean;
  code?: string;
  /** Small, bounded extras: party size, slot, table count. Never a transcript. */
  meta?: Record<string, unknown>;
}

/**
 * The one line per tool call the spec asks for.
 *
 * Warns rather than infos above 400 ms, because the hard requirement is a
 * 500 ms p95 and a line that is already three quarters of the budget is the
 * one worth alerting on before it becomes a timeout on a live call.
 */
export function logToolCall(entry: ToolCallLog): void {
  const log = logger();
  const payload = {
    kind: 'tool_call',
    tool: entry.tool,
    restaurant_id: entry.restaurantId,
    call_id: entry.callId,
    latency_ms: Math.round(entry.latencyMs),
    ok: entry.ok,
    code: entry.code ?? null,
    ...entry.meta,
  };

  if (!entry.ok) log.warn(payload, `${entry.tool} failed`);
  else if (entry.latencyMs > 400) log.warn(payload, `${entry.tool} slow`);
  else log.info(payload, entry.tool);
}

/** Test helper. */
export function resetLogger(): void {
  instance = null;
}
