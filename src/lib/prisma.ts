import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

let client: PrismaClient | null = null;

export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    datasources: { db: { url: env().DATABASE_URL } },
    log: env().NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
