import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env } from '../lib/env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { getLoggerConfig, logger, logToolCall } from '../lib/logger.js';
import { buildContext, type AppContext } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerVoiceRoutes } from './routes/voice.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    /** Raw body bytes, needed for HMAC verification. */
    rawBody?: string;
    /** Set by the voice and admin auth hooks. */
    restaurantId?: string;
    restaurantSlug?: string;
    callId?: string | null;
    /** Set by the tool-call logging hook. */
    startedAtMs?: number;
    toolName?: string;
  }
}

export interface BuildAppOptions {
  context?: Partial<AppContext>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = env();
  const app = Fastify({
    logger: getLoggerConfig(),
    // The voice platform sends a request id; reusing it means one identifier
    // spans the call transcript, our logs and their dashboard.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_000_000,
    disableRequestLogging: true,
  });

  app.decorate('ctx', buildContext(options.context));

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.JWT_SECRET });

  /**
   * Keep the raw body.
   *
   * HMAC signatures cover the exact bytes that were sent. Re-serialising the
   * parsed object changes key order and whitespace, so a signature computed
   * over JSON.stringify(body) would never match a correct one.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    (req as FastifyRequest).rawBody = raw;
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      done(new AppError('bad_request', `Malformed JSON: ${message}`), undefined);
    }
  });

  // One structured log line per tool call, with latency, so the slow path is
  // a filter rather than a grep.
  app.addHook('onRequest', async (req) => {
    req.startedAtMs = performance.now();
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.toolName) return;
    logToolCall({
      tool: req.toolName,
      restaurantId: req.restaurantId ?? null,
      callId: req.callId ?? null,
      latencyMs: performance.now() - (req.startedAtMs ?? performance.now()),
      ok: reply.statusCode < 400,
      code: reply.statusCode >= 400 ? String(reply.statusCode) : undefined,
      meta: { status: reply.statusCode, request_id: req.id },
    });
  });

  /**
   * The agent must never receive a stack trace, a Prisma error or a Zod issue
   * list — it will try to read them to the caller. Everything leaves here as
   * { ok: false, code, speech_hint }.
   */
  app.setErrorHandler((error, req, reply) => {
    const isVoice = req.url.startsWith('/v1/voice');

    if (isAppError(error)) {
      req.log.warn(
        { err: error.message, code: error.code, details: error.details, url: req.url },
        'request failed',
      );
      return reply.status(error.status).send(error.toResponse());
    }

    if (error instanceof ZodError) {
      // The detail goes to the log; the caller gets a sentence.
      req.log.warn({ issues: error.issues, url: req.url }, 'validation failed');
      const appError = new AppError('bad_request', 'Request validation failed', {
        details: { issues: error.issues },
      });
      return reply
        .status(400)
        .send(isVoice ? appError.toResponse() : { ...appError.toResponse(), issues: error.issues });
    }

    // Fastify's own validation and 404s arrive with a statusCode.
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status < 500) {
      req.log.warn({ err: message, url: req.url }, 'request rejected');
      return reply.status(status).send(new AppError('bad_request', message).toResponse());
    }

    req.log.error({ err: error, url: req.url }, 'unhandled error');
    return reply.status(500).send(new AppError('internal', 'Unhandled error').toResponse());
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(new AppError('not_found', `No route for ${req.method} ${req.url}`).toResponse());
  });

  app.get('/health', async () => {
    // Deliberately shallow: a health check that queries Postgres will flap
    // every time the database has a slow second, and take the phone line with it.
    return { ok: true, service: 'aicallcenter' };
  });

  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await app.ctx.db.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }
    try {
      await app.ctx.cache.ping();
      checks.redis = true;
    } catch {
      checks.redis = false;
    }
    const ready = checks.database === true;
    return reply.status(ready ? 200 : 503).send({ ok: ready, checks });
  });

  await app.register(registerVoiceRoutes, { prefix: '/v1/voice' });
  await app.register(registerAdminRoutes, { prefix: '/v1/admin' });
  await app.register(registerPublicRoutes, { prefix: '/v1/public' });

  return app;
}
