import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BULL_BOARD_ADAPTER, BullBoardModule } from '@bull-board/nestjs';
import { Inject, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { RECONCILIATION_QUEUE, STRIPE_EVENTS_QUEUE } from '../queue/queue.module.js';
import type { Express, RequestHandler } from 'express';
import { createBasicAuth } from './basic-auth.js';
import { createLoginLimiter } from './login-limit.js';
import { rejectCrossSite } from './same-origin.js';
import { rejectScheduleChanges } from './schedule-guard.js';

/** Where the queue dashboard is served. */
export const DASHBOARD_ROUTE = '/admin/queues';

/**
 * The login rate limit, the login, the cross-site check, then the schedule guard, in that order:
 * Bull Board's `middleware` option takes one function.
 * @param loginLimit The failed-login rate limit; first, so a locked-out IP never reaches the check.
 * @param basicAuth The Basic auth middleware.
 */
function dashboardGuard(loginLimit: RequestHandler, basicAuth: RequestHandler): RequestHandler {
  return (req, res, next) =>
    loginLimit(req, res, () =>
      basicAuth(req, res, () =>
        rejectCrossSite(req, res, () => rejectScheduleChanges(req, res, next)),
      ),
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
          createLoginLimiter(),
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
export class AdminModule {
  /**
   * Bull Board serves the dashboard from its own Express app, which adds `X-Powered-By: Express`
   * after helmet has removed it; turned off here, like on the main app.
   * @param adapter Bull Board's Express adapter; `getRouter()` returns its Express app.
   */
  constructor(@Inject(BULL_BOARD_ADAPTER) adapter: ExpressAdapter) {
    (adapter.getRouter() as Express).disable('x-powered-by');
  }
}
