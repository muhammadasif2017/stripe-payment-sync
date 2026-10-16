import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { StripeEventHandler } from './stripe-event-handler.js';
import { StripeEventsProcessor } from './stripe-events.processor.js';

/**
 * The background worker: Stripe events, reconciliation repairs and the daily reconciliation run.
 * Loaded only when `WORKER_ENABLED` isn't `false` (see `AppModule`), so the same app can run as API
 * only, worker only, or both.
 */
@Module({
  imports: [ReconciliationModule],
  providers: [StripeEventHandler, StripeEventsProcessor],
})
export class WorkerModule {}
