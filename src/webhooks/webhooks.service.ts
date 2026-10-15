import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { STRIPE_EVENTS_QUEUE, type StripeEventJob } from '../queue/queue.module.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';
import { isHandledEventType } from './handled-events.js';

/** What happened to a verified event. */
export type RecordResult = 'stored' | 'duplicate' | 'ignored';

/** Checks that webhook requests really come from Stripe, then stores and queues the events. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @InjectQueue(STRIPE_EVENTS_QUEUE) private readonly queue: Queue<StripeEventJob>,
  ) {}

  /**
   * Verifies the `Stripe-Signature` header against the raw request body and returns the event.
   * The signature is an HMAC of the exact bytes Stripe sent, keyed with the webhook secret, so it
   * proves the sender knows the secret and the body wasn't changed. Stripe's library also rejects
   * signatures older than 5 minutes, so a captured request can't be replayed later.
   * @param rawBody The request body exactly as received (`req.rawBody`).
   * @param signature The `Stripe-Signature` header.
   * @throws BadRequestException (400) when the header is missing, the signature doesn't match, or the
   *   event comes from live mode. The reason is logged; the response stays generic.
   */
  verifyEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
    if (!rawBody || !signature) {
      this.logger.warn('Webhook rejected: missing body or Stripe-Signature header');
      throw new BadRequestException('Invalid Stripe signature');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true }),
      );
    } catch (error) {
      this.logger.warn(
        `Webhook rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Invalid Stripe signature');
    }

    // Test mode only, like the sk_test_ check at startup.
    if (event.livemode) {
      this.logger.warn(`Webhook rejected: live-mode event ${event.id} (${event.type})`);
      throw new BadRequestException('Live-mode events are not accepted');
    }
    return event;
  }

  /**
   * Stores a verified event once and queues it for the worker. No processing happens here.
   * The event is stored before it is queued, and both steps are safe to repeat: the event ID is the
   * table's primary key and the job's ID. So if anything fails, the error reaches Stripe as a 500,
   * Stripe redelivers the event later, and the retry finishes whatever step was missing.
   * @param event An event returned by {@link verifyEvent}.
   * @returns `ignored` for types the worker doesn't handle (nothing saved), `duplicate` when the event
   *   was already stored, otherwise `stored`.
   * @throws Any database or Redis error other than a duplicate event ID, so Stripe retries.
   */
  async recordEvent(event: Stripe.Event): Promise<RecordResult> {
    if (!isHandledEventType(event.type)) {
      this.logger.debug(`Ignored ${event.type} event ${event.id}`);
      return 'ignored';
    }

    let result: RecordResult = 'stored';
    try {
      await this.prisma.stripeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonObject,
          stripeCreatedAt: new Date(event.created * 1000),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      result = 'duplicate';
    }

    // Also for duplicates: a delivery that stored the event but failed to queue it is completed here.
    // BullMQ ignores the add if a job with this ID already exists.
    await this.queue.add('stripe-event', { eventId: event.id }, { jobId: event.id });

    this.logger.log(`${result === 'stored' ? 'Stored' : 'Duplicate'} ${event.type} event ${event.id}`);
    return result;
  }
}
