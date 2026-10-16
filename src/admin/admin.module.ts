import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { STRIPE_EVENTS_QUEUE } from '../queue/queue.module.js';
import { createBasicAuth } from './basic-auth.js';

/** Where the queue dashboard is served. */
export const DASHBOARD_ROUTE = '/admin/queues';

/**
 * Bull Board, a web dashboard for the BullMQ queues, at {@link DASHBOARD_ROUTE}. It shows waiting,
 * failed and completed jobs with their errors, and can retry a failed job. Every path under the route
 * (the page, its files and its JSON API) is behind HTTP Basic auth.
 */
@Module({
  imports: [
    BullBoardModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        route: DASHBOARD_ROUTE,
        adapter: ExpressAdapter,
        middleware: createBasicAuth({
          username: config.get('ADMIN_USERNAME', { infer: true }),
          password: config.get('ADMIN_PASSWORD', { infer: true }),
        }),
      }),
    }),
    BullBoardModule.forFeature({ name: STRIPE_EVENTS_QUEUE, adapter: BullMQAdapter }),
  ],
})
export class AdminModule {}
