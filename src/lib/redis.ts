import { Redis } from 'ioredis';
import { env } from './env.js';

let client: Redis | null = null;

export function redis(): Redis {
  client ??= new Redis(env().REDIS_URL, {
    // The caller is on the phone. A Redis blip must degrade to "the database
    // is the truth" in milliseconds, not stall the request behind retries.
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    commandTimeout: 250,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
