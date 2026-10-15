import { Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service.js';

/** Receives Stripe's webhooks. Configure Stripe (or `stripe listen`) to send them to `/webhooks/stripe`. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Accepts one Stripe event after checking its signature.
   * Answers as fast as possible: Stripe treats a slow or failed answer as a failed delivery and retries.
   * @returns 200 `{ received: true }`; 400 when the signature check fails.
   */
  @Post('stripe')
  @HttpCode(200)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): { received: true } {
    this.webhooks.verifyEvent(req.rawBody, signature);
    return { received: true };
  }
}
