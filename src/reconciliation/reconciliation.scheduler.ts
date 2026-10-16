import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../config/env.validation.js';
import {
  RECONCILIATION_JOB,
  RECONCILIATION_QUEUE,
  RECONCILIATION_SCHEDULER_ID,
} from '../queue/queue.module.js';

/**
 * Registers the daily reconciliation with BullMQ when the worker starts. The schedule lives in Redis:
 * with several workers only one takes each run, and `upsertJobScheduler` is safe to call from every
 * worker on every start (it updates the pattern if `RECONCILIATION_CRON` changed).
 */
@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    @InjectQueue(RECONCILIATION_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Creates or updates the scheduler. Throws if Redis is unreachable, so a worker never runs without it. */
  async onApplicationBootstrap(): Promise<void> {
    const pattern = this.config.get('RECONCILIATION_CRON', { infer: true });
    await this.queue.upsertJobScheduler(
      RECONCILIATION_SCHEDULER_ID,
      { pattern, tz: 'UTC' },
      { name: RECONCILIATION_JOB, data: {} },
    );
    this.logger.log(`Reconciliation scheduled: "${pattern}" (UTC)`);
  }
}
