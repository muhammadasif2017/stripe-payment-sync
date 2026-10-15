import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Creates a Prisma client for database tests, connected to the test database
 * (vitest.config.e2e.ts points DATABASE_URL at payments_test).
 * Uses the same connection timeout as PrismaService, so an unresponsive database fails the
 * tests after 5 seconds instead of hanging the run. Call `$disconnect()` in `afterAll`.
 */
export function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5_000,
    }),
  });
}
