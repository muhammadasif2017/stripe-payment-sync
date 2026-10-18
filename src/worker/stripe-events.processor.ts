import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, type Queue, UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  RECONCILE_SESSION_JOB,
  STRIPE_EVENT_JOB,
  STRIPE_EVENTS_QUEUE,
  type ReconcileSessionJob,
  type StripeEventJob,
} from '../queue/queue.module.js';
import { PermanentProcessingError } from './mapping.js';
import { StripeEventHandler } from './stripe-event-handler.js';

/** Longest error text saved on an event; enough for any message, small enough for a table cell. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Consumes the `stripe-events` queue, up to 5 jobs at a time. Two kinds of job:
 * - `stripe-event`: one stored Stripe event; every attempt is recorded on its `stripe_events` row.
 * - `reconcile-session`: one Checkout Session repair queued by reconciliation; it has no event row,
 *   so its attempts and errors live in the job (visible on the dashboard) and the log.
 * Retries come from the queue's job options (5 attempts, exponential backoff); this class tells
 * BullMQ which failures are worth retrying.
 */
@Processor(STRIPE_EVENTS_QUEUE, { concurrency: 5 })
export class StripeEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeEventsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handler: StripeEventHandler,
    @InjectQueue(STRIPE_EVENTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /**
   * Processes one job. Throwing makes BullMQ retry it, except for `UnrecoverableError`, which fails
   * the job at once.
   * @param job The job; its name says what kind it is, its data names the event or session.
   */
  async process(job: Job<Partial<StripeEventJob & ReconcileSessionJob>>): Promise<void> {
    // attemptsMade counts the attempts that already failed, so this one is attemptsMade + 1.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // Jobs can also be added by hand on the dashboard, so check the name and data before trusting them.
    const { eventId, sessionId } = job.data ?? {};
    if (job.name === STRIPE_EVENT_JOB && typeof eventId === 'string' && eventId) {
      return this.processEvent(eventId, attempt, maxAttempts);
    }
    if (job.name === RECONCILE_SESSION_JOB && typeof sessionId === 'string' && sessionId) {
      return this.processRepair(sessionId, attempt, maxAttempts);
    }
    throw new UnrecoverableError(`Job ${job.id} has an unknown name or data: ${job.name}`);
  }

  /** Applies one stored Stripe event, recording each attempt on its `stripe_events` row. */
  private async processEvent(eventId: string, attempt: number, maxAttempts: number): Promise<void> {
    let event;
    try {
      event = await this.prisma.stripeEvent.findUnique({ where: { id: eventId } });
    } catch (error) {
      // Usually the database is down. Log it (saving it will fail too, which is also logged) and retry.
      await this.recordFailure(eventId, attempt, error, attempt >= maxAttempts);
      throw error;
    }
    if (!event) {
      throw new UnrecoverableError(`Event ${eventId} is not in stripe_events`);
    }
    if (event.status === 'PROCESSED' || event.status === 'RECONCILED') {
      this.logger.log(`Event ${eventId} was already ${event.status.toLowerCase()}; nothing to do`);
      return;
    }

    try {
      await this.handler.handle(event, attempt);
      this.logger.log(`Processed ${event.type} event ${eventId} (attempt ${attempt})`);
    } catch (error) {
      const permanent = error instanceof PermanentProcessingError;
      const final = permanent || attempt >= maxAttempts;
      await this.recordFailure(eventId, attempt, error, final);
      if (permanent) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /** Repairs one Checkout Session. Failures are logged; there is no event row to save them on. */
  private async processRepair(
    sessionId: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    try {
      const settled = await this.handler.reconcileSession(sessionId);
      this.logger.log(
        `Repaired Checkout Session ${sessionId} (attempt ${attempt})` +
          (settled.length ? `; marked RECONCILED: ${settled.join(', ')}` : ''),
      );
      await this.clearFailedJobs(settled);
    } catch (error) {
      const permanent = error instanceof PermanentProcessingError;
      const final = permanent || attempt >= maxAttempts;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(
        `Repair of Checkout Session ${sessionId} failed on attempt ${attempt}${final ? ' (giving up)' : ', will retry'}: ${message}`,
      );
      if (permanent) {
        await this.recordIssue(sessionId, error);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /**
   * Records a repair that can't succeed as one open reconciliation issue, so later runs skip the
   * session instead of failing it again every day. A repeat failure updates the same row (and reopens
   * it if someone had resolved it). A failure to save is logged and never replaces the original error.
   */
  private async recordIssue(sessionId: string, error: PermanentProcessingError): Promise<void> {
    const reason = error.message.slice(0, MAX_ERROR_LENGTH);
    try {
      await this.prisma.reconciliationIssue.upsert({
        where: { stripeCheckoutSessionId: sessionId },
        create: { stripeCheckoutSessionId: sessionId, orderId: error.orderId, reason },
        update: { orderId: error.orderId, reason, lastSeenAt: new Date(), resolvedAt: null },
      });
      this.logger.warn(
        `Recorded reconciliation issue for Checkout Session ${sessionId}: ${reason}`,
      );
    } catch (saveError) {
      this.logger.error(
        `Could not record the reconciliation issue for ${sessionId}: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
      );
    }
  }

  /**
   * Removes the failed jobs of events a repair settled, so the dashboard's Failed list only shows what
   * still needs attention. The error stays on the event row. Runs after the repair committed; a
   * failure here is logged and doesn't fail the repair.
   * @param eventIds Settled events; an event's job ID is its event ID.
   */
  private async clearFailedJobs(eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) {
      try {
        const job = await this.queue.getJob(eventId);
        if (job && (await job.getState()) === 'failed') {
          await job.remove();
        }
      } catch (error) {
        this.logger.warn(
          `Could not remove the failed job of event ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Saves the attempt count and the error on the event: `FAILED` when no retry will follow, otherwise
   * still `PENDING`. If saving fails too (the database is the problem), that is logged and the original
   * error still goes back to BullMQ.
   */
  private async recordFailure(
    eventId: string,
    attempt: number,
    error: unknown,
    final: boolean,
  ): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.logger.warn(
      `Event ${eventId} failed on attempt ${attempt}${final ? ' (giving up)' : ', will retry'}: ${message}`,
    );
    try {
      await this.prisma.stripeEvent.update({
        where: { id: eventId },
        data: {
          attempts: attempt,
          lastError: message.slice(0, MAX_ERROR_LENGTH),
          status: final ? 'FAILED' : 'PENDING',
        },
      });
    } catch (saveError) {
      this.logger.error(
        `Could not save the failure of event ${eventId}: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
      );
    }
  }
}
