import { buildApp } from './http/app.js';
import { env } from './lib/env.js';
import { disconnectPrisma } from './lib/prisma.js';
import { disconnectRedis } from './lib/redis.js';

async function main(): Promise<void> {
  const config = env();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    // Close the HTTP server first so in-flight calls finish before the
    // connections they depend on are torn out from under them.
    await app.close().catch(() => undefined);
    await disconnectPrisma().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT }, 'aicallcenter listening');
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
