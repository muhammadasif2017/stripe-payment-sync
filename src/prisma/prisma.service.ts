import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.validation.js';

/**
 * The app's single Prisma client. Inject this wherever the database is needed;
 * one shared instance means one connection pool for the whole process.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    // Prisma 7 talks to PostgreSQL through a driver adapter (node-postgres) instead of a bundled engine.
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        // node-postgres waits forever for a connection by default. If the database silently stops
        // answering (network drop, not a refused connection), fail after 5s instead of hanging requests.
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  /** Opens the connection pool when the module starts. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Closes the pool on shutdown so the process can exit cleanly. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
