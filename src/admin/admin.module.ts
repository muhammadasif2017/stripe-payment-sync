import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { RECONCILIATION_QUEUE, STRIPE_EVENTS_QUEUE } from '../queue/queue.module.js';
import type { RequestHandler } from 'express';
import { createBasicAuth } from './basic-auth.js';
import { rejectCrossSite } from './same-origin.js';
import { rejectScheduleChanges } from './schedule-guard.js';

/** Where the queue dashboard is served. */
export const DASHBOARD_ROUTE = '/admin/queues';

/**
 * The login, then the cross-site check, then the schedule guard, in that order: Bull Board's
 * `middleware` option takes one function.
 * @param basicAuth The Basic auth middleware.
 */
function dashboardGuard(basicAuth: RequestHandler): RequestHandler {
  return (req, res, next) =>
    basicAuth(req, res, () =>
      rejectCrossSite(req, res, () => rejectScheduleChanges(req, res, next)),
    );
}

/**
 * Bull Board, a web dashboard for the BullMQ queues, at {@link DASHBOARD_ROUTE}. It shows waiting,
 * failed and completed jobs with their errors, and can retry a failed job. Every path under the route
 * (the page, its files and its JSON API) is behind HTTP Basic auth, and changes sent from another
 * site are refused.
 */
@Module({
  imports: [
    BullBoardModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        route: DASHBOARD_ROUTE,
        adapter: ExpressAdapter,
        middleware: dashboardGuard(
          createBasicAuth({
            username: config.get('ADMIN_USERNAME', { infer: true }),
            password: config.get('ADMIN_PASSWORD', { infer: true }),
          }),
        ),
      }),
    }),
    BullBoardModule.forFeature(
      { name: STRIPE_EVENTS_QUEUE, adapter: BullMQAdapter },
      { name: RECONCILIATION_QUEUE, adapter: BullMQAdapter },
    ),
  ],
})
export class AdminModule {}
