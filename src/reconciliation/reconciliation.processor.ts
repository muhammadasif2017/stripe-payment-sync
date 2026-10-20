import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { RECONCILIATION_JOB, RECONCILIATION_QUEUE } from '../queue/queue.module.js';
import type { ReconciliationSummary } from './missing-payments.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * Runs reconciliation jobs, one at a time: two runs at once would only list the same sessions twice.
 * The summary is the job's return value, so the dashboard shows what each run found.
 */
@Processor(RECONCILIATION_QUEUE, { concurrency: 1 })
export class ReconciliationProcessor extends WorkerHost {
  constructor(private readonly reconciliation: ReconciliationService) {
    super();
  }

  /** Stops taking jobs and waits for a running one, before the database pool closes. */
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  /**
   * Runs one reconciliation. A thrown error is retried by BullMQ (the queue's job options).
   * @param job The scheduled or manually started job.
   */
  async process(job: Job): Promise<ReconciliationSummary> {
    if (job.name !== RECONCILIATION_JOB) {
      throw new UnrecoverableError(`Unknown job name on ${RECONCILIATION_QUEUE}: ${job.name}`);
    }
    return this.reconciliation.run();
  }
}
