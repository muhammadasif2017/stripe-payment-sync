import { Module } from '@nestjs/common';
import { ReconciliationProcessor } from './reconciliation.processor.js';
import { ReconciliationScheduler } from './reconciliation.scheduler.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * The daily reconciliation: its schedule, its processor and the run itself. Imported by the worker,
 * so it runs wherever Stripe events are processed. The queue itself is registered in `QueueModule`,
 * so the API-only process and the dashboard can see it and start a run.
 */
@Module({
  providers: [ReconciliationService, ReconciliationProcessor, ReconciliationScheduler],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
