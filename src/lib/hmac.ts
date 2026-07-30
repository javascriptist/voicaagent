import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * Webhook signature verification for the voice platform.
 *
 * Scheme: the sender computes
 *
 *   signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 *
 * and sends it as `X-Signature: v1=<hex>` alongside `X-Timestamp: <unix seconds>`.
 *
 * Three properties matter and each is easy to get wrong:
 *
 *   The timestamp is inside the signed payload. Signing only the body lets an
 *   attacker replay a valid request forever with a fresh timestamp header.
 *
 *   The comparison is constant time. A byte-by-byte early return leaks the
 *   expected signature to anyone willing to send a few thousand requests.
 *
 *   The raw body is signed, not the parsed JSON. Re-serialising changes key
 *   order and whitespace, so the signature would never match; Fastify is
 *   configured to keep the raw buffer for exactly this reason.
 */

export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';

export interface VerifyOptions {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  /** Seconds either side of now that a timestamp may fall. */
  windowSeconds: number;
  now?: Date;
}

export function sign(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Build the header pair a client should send. Used by tests and the README. */
export function signedHeaders(
  secret: string,
  rawBody: string,
  now: Date = new Date(),
): { [SIGNATURE_HEADER]: string; [TIMESTAMP_HEADER]: string } {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    [SIGNATURE_HEADER]: `v1=${sign(secret, timestamp, rawBody)}`,
    [TIMESTAMP_HEADER]: String(timestamp),
  };
}

export function verifySignature(options: VerifyOptions): void {
  const { secret, rawBody, signatureHeader, timestampHeader, windowSeconds } = options;
  const now = options.now ?? new Date();

  if (!signatureHeader) {
    throw new AppError('invalid_signature', `Missing ${SIGNATURE_HEADER} header`);
  }
  if (!timestampHeader) {
    throw new AppError('invalid_signature', `Missing ${TIMESTAMP_HEADER} header`);
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    throw new AppError('invalid_signature', `Malformed ${TIMESTAMP_HEADER} header`);
  }

  // Rejected in both directions. A far-future timestamp is as much a replay
  // signal as a stale one, and clock skew beyond five minutes is a real
  // problem worth surfacing rather than tolerating.
  const skewSeconds = Math.abs(now.getTime() / 1000 - timestamp);
  if (skewSeconds > windowSeconds) {
    throw new AppError(
      'stale_timestamp',
      `Timestamp is ${Math.round(skewSeconds)}s from now, window is ${windowSeconds}s`,
      { details: { skewSeconds: Math.round(skewSeconds) } },
    );
  }

  // Tolerate a bare hex signature as well as the versioned form, but never
  // accept a version we do not implement.
  const provided = signatureHeader.startsWith('v1=') ? signatureHeader.slice(3) : signatureHeader;
  if (signatureHeader.includes('=') && !signatureHeader.startsWith('v1=')) {
    throw new AppError('invalid_signature', 'Unsupported signature version');
  }

  const expected = sign(secret, timestampHeader, rawBody);
  if (!safeEqualHex(provided, expected)) {
    throw new AppError('invalid_signature', 'Signature mismatch');
  }
}

/**
 * Constant-time hex comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, which would itself
 * leak the expected length, so length is checked first and a mismatch fails
 * without calling it. Comparing hex strings rather than decoding means a
 * malformed signature cannot smuggle in a shorter buffer.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
