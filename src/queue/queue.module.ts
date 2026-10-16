import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DefaultJobOptions } from 'bullmq';
import type { Env } from '../config/env.validation.js';

/** Queue of Stripe events waiting for the worker. Each job's ID is the Stripe event ID. */
export const STRIPE_EVENTS_QUEUE = 'stripe-events';

/** Name of a job that processes one stored Stripe event. */
export const STRIPE_EVENT_JOB = 'stripe-event';

/** Name of a job that repairs one paid Checkout Session found by reconciliation (stage 7). */
export const RECONCILE_SESSION_JOB = 'reconcile-session';

/** Data of a {@link STRIPE_EVENT_JOB} job. The event itself is in `stripe_events`, not in Redis. */
export interface StripeEventJob {
  eventId: string;
}

/** Data of a {@link RECONCILE_SESSION_JOB} job. */
export interface ReconcileSessionJob {
  sessionId: string;
}

/**
 * Retry and retention settings for every Stripe event job.
 * - 5 attempts, waiting 10 s, 20 s, 40 s, 80 s between them: rides out a short database or Stripe outage.
 * - Completed jobs are kept for 7 days. While a job exists, adding another with the same job ID is
 *   ignored, so a late duplicate delivery from Stripe doesn't queue the event again.
 * - Failed jobs are kept, so they can be inspected and retried from the dashboard (stage 6).
 */
export const STRIPE_EVENT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: false,
};

/** Queue for the daily reconciliation run (stage 7); its job scheduler keeps the next run here. */
export const RECONCILIATION_QUEUE = 'reconciliation';

/** Name of the job that runs one reconciliation. */
export const RECONCILIATION_JOB = 'reconcile';

/** ID of the job scheduler that adds a {@link RECONCILIATION_JOB} every day. */
export const RECONCILIATION_SCHEDULER_ID = 'daily-reconciliation';

/**
 * Settings for a reconciliation run.
 * - 3 attempts, 1 then 2 minutes apart: a Stripe or database blip shouldn't skip a whole day.
 * - Completed runs are kept 30 days: each one's return value is its summary, readable on the dashboard.
 */
export const RECONCILIATION_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: 30 * 24 * 60 * 60 },
  removeOnFail: false,
};

/** Connects BullMQ to Redis and registers the queues. Inject a queue with `@InjectQueue(name)`. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          url: config.get('REDIS_URL', { infer: true }),
          // Fail at once when Redis is down instead of buffering commands: the webhook then answers
          // 500 and Stripe redelivers the event later, rather than the request hanging.
          enableOfflineQueue: false,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: STRIPE_EVENTS_QUEUE, defaultJobOptions: STRIPE_EVENT_JOB_OPTIONS },
      // Registered here, not only in the worker, so the API-only process and the dashboard see it.
      { name: RECONCILIATION_QUEUE, defaultJobOptions: RECONCILIATION_JOB_OPTIONS },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
