import { Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service.js';

/** Receives Stripe's webhooks. Configure Stripe (or `stripe listen`) to send them to `/webhooks/stripe`. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Accepts one Stripe event: checks its signature, stores it and queues it, nothing more.
   * Answers as fast as possible: Stripe treats a slow or failed answer as a failed delivery and retries.
   * @returns 200 `{ received: true }`, also for duplicates and ignored types; 400 when the signature
   *   check fails; 500 when the event couldn't be stored or queued, so Stripe sends it again.
   */
  @Post('stripe')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const event = this.webhooks.verifyEvent(req.rawBody, signature);
    await this.webhooks.recordEvent(event);
    return { received: true };
  }
}
