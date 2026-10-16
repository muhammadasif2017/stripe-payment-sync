import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { STRIPE_EVENTS_QUEUE, type StripeEventJob } from '../queue/queue.module.js';
import { PermanentProcessingError } from './mapping.js';
import { StripeEventHandler } from './stripe-event-handler.js';

/** Longest error text saved on an event; enough for any message, small enough for a table cell. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Consumes the `stripe-events` queue: one job per Stripe event, up to 5 at a time.
 * Retries come from the queue's job options (5 attempts, exponential backoff); this class records
 * every attempt on the event row and tells BullMQ which failures are worth retrying.
 */
@Processor(STRIPE_EVENTS_QUEUE, { concurrency: 5 })
export class StripeEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeEventsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handler: StripeEventHandler,
  ) {
    super();
  }

  /**
   * Processes one job. Throwing makes BullMQ retry it, except for `UnrecoverableError`, which fails
   * the job at once.
   * @param job The job; its data names the stored event.
   */
  async process(job: Job<StripeEventJob>): Promise<void> {
    const { eventId } = job.data;
    // attemptsMade counts the attempts that already failed, so this one is attemptsMade + 1.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // A database outage throws here and is retried like any other failure.
    const event = await this.prisma.stripeEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      throw new UnrecoverableError(`Event ${eventId} is not in stripe_events`);
    }
    if (event.status === 'PROCESSED') {
      this.logger.log(`Event ${eventId} was already processed; nothing to do`);
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
