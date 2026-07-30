import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * Vonage AI Studio webhook verification.
 *
 * AI Studio does not send a bare HMAC header. It signs each webhook with a
 * JWT in `Authorization: Bearer <token>`, signed HS256 with the account's
 * signature secret, carrying:
 *
 *   iat           issued at, unix seconds
 *   jti           unique per request
 *   api_key       the Vonage account
 *   payload_hash  SHA-256 hex of the raw request body
 *
 * So verification is three separate checks, and skipping any one of them
 * leaves a real hole:
 *
 *   The JWT signature proves Vonage sent it. Alone, it does not prove *what*
 *   they sent — the body is not part of the JWT.
 *
 *   `payload_hash` binds the token to this body. Without it, a valid token
 *   captured from one webhook can be replayed with a different body, which is
 *   a free "cancel every booking" primitive.
 *
 *   `iat` inside the window stops a captured request being replayed later.
 *
 * The secret is stored per restaurant, so one restaurant's leaked secret
 * cannot be used to write to another's bookings.
 */

const ALGORITHM = 'HS256';

export interface VonageVerifyOptions {
  secret: string;
  rawBody: string;
  authorizationHeader: string | undefined;
  windowSeconds: number;
  now?: Date;
}

export interface VonageClaims {
  iat: number;
  jti?: string;
  api_key?: string;
  payload_hash?: string;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a webhook the way AI Studio does. Used by tests and the README. */
export function signVonageWebhook(
  secret: string,
  rawBody: string,
  now: Date = new Date(),
  apiKey = 'test-api-key',
): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' })));
  const claims: VonageClaims = {
    iat: Math.floor(now.getTime() / 1000),
    jti: `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    api_key: apiKey,
    payload_hash: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
  };
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const signature = base64UrlEncode(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

export function verifyVonageWebhook(options: VonageVerifyOptions): VonageClaims {
  const { secret, rawBody, authorizationHeader, windowSeconds } = options;
  const now = options.now ?? new Date();

  if (!authorizationHeader) {
    throw new AppError('invalid_signature', 'Missing Authorization header');
  }
  const token = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError('invalid_signature', 'Authorization header is not a JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
  } catch {
    throw new AppError('invalid_signature', 'Malformed JWT header');
  }
  // Pinned. Accepting `alg` from the token is the classic JWT confusion
  // attack: "none" would let anyone forge one.
  if (header.alg !== ALGORITHM) {
    throw new AppError('invalid_signature', `Unsupported JWT algorithm ${header.alg}`);
  }

  const expected = base64UrlEncode(
    createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest(),
  );
  if (!safeEqual(encodedSignature, expected)) {
    throw new AppError('invalid_signature', 'JWT signature mismatch');
  }

  let claims: VonageClaims;
  try {
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    throw new AppError('invalid_signature', 'Malformed JWT payload');
  }

  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    throw new AppError('invalid_signature', 'JWT has no usable iat claim');
  }
  const skewSeconds = Math.abs(now.getTime() / 1000 - claims.iat);
  if (skewSeconds > windowSeconds) {
    throw new AppError(
      'stale_timestamp',
      `JWT iat is ${Math.round(skewSeconds)}s from now, window is ${windowSeconds}s`,
      { details: { skewSeconds: Math.round(skewSeconds) } },
    );
  }

  // Binds this token to this exact body. A signature that does not cover the
  // payload can be lifted from a harmless webhook and replayed over a
  // cancel-booking body.
  if (typeof claims.payload_hash !== 'string') {
    throw new AppError('invalid_signature', 'JWT has no payload_hash claim');
  }
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  if (!safeEqual(claims.payload_hash, bodyHash)) {
    throw new AppError('invalid_signature', 'payload_hash does not match the request body');
  }

  return claims;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
