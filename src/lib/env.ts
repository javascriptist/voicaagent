import { z } from 'zod';

/**
 * Configuration, validated once at boot.
 *
 * A missing secret should stop the process on startup, not surface as a
 * signature mismatch on a live call three hours later.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  // Embeddings. Empty key falls back to the deterministic offline embedder.
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-small'),

  NOTIFIER: z.enum(['noop', 'vonage', 'twilio']).default('noop'),
  VONAGE_API_KEY: z.string().default(''),
  VONAGE_API_SECRET: z.string().default(''),
  VONAGE_SMS_FROM: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),

  /**
   * Webhook verification for Vonage AI Studio.
   *
   * `vonage_jwt` is the real scheme: AI Studio signs each webhook with a JWT
   * in the Authorization header, carrying a SHA-256 hash of the body.
   * `hmac` is the generic scheme kept for the web widget and for local
   * testing without a Vonage account. `both` accepts either.
   */
  WEBHOOK_AUTH: z.enum(['vonage_jwt', 'hmac', 'both']).default('both'),

  HMAC_TIMESTAMP_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(180),

  /**
   * Hard ceiling per voice endpoint. Vonage AI Studio's Webhook node drops
   * into its error branch at five seconds, so anything approaching that is a
   * dropped call rather than a slow one. Requests over this are logged at
   * error level; the build-failing assertion lives in the latency test.
   */
  VOICE_LATENCY_BUDGET_MS: z.coerce.number().int().positive().default(1500),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NOTIFIER === 'twilio') {
    const missing = (['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] as const).filter(
      (k) => !parsed.data[k],
    );
    if (missing.length > 0) throw new Error(`NOTIFIER=twilio requires ${missing.join(', ')}`);
  }
  if (parsed.data.NOTIFIER === 'vonage') {
    const missing = (['VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_SMS_FROM'] as const).filter(
      (k) => !parsed.data[k],
    );
    if (missing.length > 0) throw new Error(`NOTIFIER=vonage requires ${missing.join(', ')}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper: forget the cached env so a test can change it. */
export function resetEnv(): void {
  cached = null;
}
