import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.validation.js';

/**
 * The app's single Prisma client. Inject this wherever the database is needed;
 * one shared instance means one connection pool for the whole process.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
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

  /**
   * Closes the pool in the last shutdown phase. Nest runs every `onModuleDestroy` first, then closes
   * the HTTP server, then runs `onApplicationShutdown`; the workers stop in `onModuleDestroy` and the
   * server waits for open requests, so by now nothing is still using the database. (Closed any
   * earlier, Prisma would quietly open a new pool for a running job's next query and leave it open.)
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
