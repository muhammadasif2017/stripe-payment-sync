import { BadGatewayException, BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';
import { findCourse } from './catalog.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

/** What the browser needs to send the customer to Stripe's payment page. */
export interface CheckoutResult {
  orderId: string;
  checkoutUrl: string;
}

/** Creates orders and the Stripe Checkout Sessions that pay for them. */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Saves a PENDING order, then creates a Checkout Session for it and links the two.
   * The order is created first because the session's metadata needs its ID. The two writes can't
   * share a transaction, so if Stripe fails the order stays PENDING with no session: no money moved.
   * Nothing here marks the order paid; only Stripe's webhook does that (stages 4 and 5).
   * @param dto Validated request body.
   * @throws BadRequestException (400) for a course that isn't in the catalog; no order is saved.
   * @throws BadGatewayException (502) when Stripe fails; the cause is logged, never returned.
   */
  async createCheckout(dto: CreateCheckoutDto): Promise<CheckoutResult> {
    const course = findCourse(dto.courseId);
    if (!course) {
      throw new BadRequestException('Unknown courseId');
    }

    const order = await this.prisma.order.create({
      data: {
        courseId: course.id,
        amount: course.amount,
        currency: course.currency,
        customerEmail: dto.email,
      },
    });

    const session = await this.createSession(order.id, course, dto.email);

    await this.prisma.order.update({
      where: { id: order.id },
      data: { stripeCheckoutSessionId: session.id },
    });

    return { orderId: order.id, checkoutUrl: session.url };
  }

  private async createSession(
    orderId: string,
    course: { name: string; amount: number; currency: string },
    email: string | undefined,
  ): Promise<{ id: string; url: string }> {
    const appUrl = this.config.get('APP_URL', { infer: true });
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          // Card only: the data model has no state for bank debits that take days to settle.
          allowed_payment_method_types: ['card'],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: course.currency,
                unit_amount: course.amount,
                product_data: { name: course.name },
              },
            },
          ],
          client_reference_id: orderId,
          customer_email: email,
          // Stripe doesn't copy session metadata to the PaymentIntent, and payment_intent.* events
          // (stage 5) carry only the PaymentIntent, so the order ID goes on both.
          metadata: { order_id: orderId },
          payment_intent_data: { metadata: { order_id: orderId } },
          success_url: `${appUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/cancel.html`,
        },
        // One session per order, however many times this request is retried.
        { idempotencyKey: orderId },
      );
    } catch (error) {
      this.logFailure(orderId, error);
      throw new BadGatewayException('Payment provider unavailable, please try again');
    }

    if (!session.url) {
      this.logFailure(orderId, new Error(`Checkout Session ${session.id} has no URL`));
      throw new BadGatewayException('Payment provider unavailable, please try again');
    }
    return { id: session.id, url: session.url };
  }

  private logFailure(orderId: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    // Stripe errors carry a type, a code and a request ID that Stripe support can look up.
    const { type, code, requestId } = err as { type?: string; code?: string; requestId?: string };
    const details = [type, code, requestId && `request ${requestId}`].filter(Boolean).join(', ');
    this.logger.error(
      `Checkout Session failed for order ${orderId}: ${err.message}${details ? ` (${details})` : ''}`,
      err.stack,
    );
  }
}
