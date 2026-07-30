/**
 * Errors that know how to be said out loud.
 *
 * Every failure the voice agent can hit carries three things: a machine code
 * for the transcript and the logs, an HTTP status, and a sentence a text to
 * speech engine can read to the caller as-is. The agent must never see a stack
 * trace, a Prisma error, or a Zod issue list — it will try to read them.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'slot_taken'
  | 'hold_expired'
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  slot_taken: 409,
  hold_expired: 410,
  invalid_signature: 401,
  stale_timestamp: 401,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/**
 * Said to the caller when nothing better is available. Deliberately vague
 * about the cause and specific about what happens next — "there was an error"
 * leaves the caller holding a dead line.
 */
const DEFAULT_SPEECH: Record<ErrorCode, string> = {
  bad_request: "Sorry, I didn't quite catch that. Could you say it again?",
  unauthorized: 'Sorry, I am not able to do that right now.',
  forbidden: 'Sorry, I am not able to do that right now.',
  not_found: "Sorry, I can't find a booking with those details. Could you check the phone number?",
  conflict: 'Sorry, something changed while I was booking that. Let me try again.',
  slot_taken: 'Sorry, that table has just gone. Let me find you another time.',
  hold_expired: 'Sorry, that table was only held for a few minutes and it has gone. Let me check again.',
  invalid_signature: 'Sorry, I am not able to do that right now.',
  stale_timestamp: 'Sorry, I am not able to do that right now.',
  rate_limited: 'Sorry, I am a little busy. Give me one moment.',
  unavailable: 'Sorry, I am having trouble reaching the booking system. Let me put you through to the team.',
  internal: 'Sorry, something went wrong on my end. Let me put you through to the team.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly speechHint: string;
  /** Extra structured context for the log line. Never sent to the caller. */
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { speechHint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.speechHint = options.speechHint ?? DEFAULT_SPEECH[code];
    this.details = options.details ?? {};
  }

  toResponse(): { ok: false; code: ErrorCode; speech_hint: string } {
    return { ok: false, code: this.code, speech_hint: this.speechHint };
  }
}

export const badRequest = (message: string, speechHint?: string, details?: Record<string, unknown>) =>
  new AppError('bad_request', message, { speechHint, details });

export const notFound = (message: string, speechHint?: string) =>
  new AppError('not_found', message, { speechHint });

export const slotTaken = (message: string, speechHint?: string) =>
  new AppError('slot_taken', message, { speechHint });

export const unauthorized = (message: string) => new AppError('unauthorized', message);

export const forbidden = (message: string) => new AppError('forbidden', message);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
