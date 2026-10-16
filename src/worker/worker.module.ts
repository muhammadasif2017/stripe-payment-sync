import { Module } from '@nestjs/common';
import { StripeEventHandler } from './stripe-event-handler.js';
import { StripeEventsProcessor } from './stripe-events.processor.js';

/**
 * The background worker for Stripe events. Loaded only when `WORKER_ENABLED` isn't `false` (see
 * `AppModule`), so the same app can run as API only, worker only, or both.
 */
@Module({
  providers: [StripeEventHandler, StripeEventsProcessor],
})
export class WorkerModule {}
