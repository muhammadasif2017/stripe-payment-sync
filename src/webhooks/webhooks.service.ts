import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';

/** Checks that webhook requests really come from Stripe. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService<Env, true>,
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
}
