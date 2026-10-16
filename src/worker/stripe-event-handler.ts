import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeCalls } from '../stripe/stripe-calls.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';
import {
  deriveOrderStatus,
  PermanentProcessingError,
  toPaymentStatus,
  toRefundStatus,
} from './mapping.js';

/** The parts of a stored `stripe_events` row the handler needs. */
export interface StoredEvent {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
}

/** The current state of the Stripe objects behind one event, fetched before the transaction. */
interface Snapshot {
  orderId: string;
  session?: Stripe.Checkout.Session;
  paymentIntent?: Stripe.PaymentIntent;
  refunds?: Stripe.Refund[];
}

/** Refunds fetched per page, Stripe's maximum. */
const REFUND_PAGE_SIZE = 100;

/** Stops a runaway pagination loop: 100 pages is 10,000 refunds, far more than one payment can have. */
const MAX_REFUND_PAGES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies one Stripe event to the database: fetches the latest objects from Stripe, then writes the
 * payment, refunds, order status and the event's PROCESSED mark in one transaction.
 */
@Injectable()
export class StripeEventHandler {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly stripeCalls: StripeCalls,
  ) {}

  /**
   * Processes a stored event. Safe to run again for the same event: payments and refunds are upserted
   * on their Stripe IDs and the order status is recomputed from scratch.
   * @param event The stored event.
   * @param attempt Which attempt this is (1 for the first), saved on the event.
   * @throws PermanentProcessingError when retrying can't help (no matching order, amounts that don't
   *   match, an object Stripe says doesn't exist); any other error is worth retrying.
   */
  async handle(event: StoredEvent, attempt: number): Promise<void> {
    const snapshot = await this.fetchSnapshot(event);

    await this.prisma.$transaction(async (tx) => {
      // Lock the order row: two jobs for the same order (say, a payment and a refund) wait for each
      // other instead of both computing the status from rows the other is about to change.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${snapshot.orderId}::uuid FOR UPDATE`;
      if (locked.length === 0) {
        throw new PermanentProcessingError(`No order ${snapshot.orderId} for event ${event.id}`);
      }
      const order = await tx.order.findUniqueOrThrow({ where: { id: snapshot.orderId } });

      if (snapshot.session) {
        checkMatchesOrder(
          order,
          snapshot.session.currency,
          snapshot.session.amount_total,
          'session',
        );
      }

      const pi = snapshot.paymentIntent;
      if (pi) {
        checkMatchesOrder(order, pi.currency, pi.amount, 'payment intent');
        const status = toPaymentStatus(pi);
        if (status) {
          const amount = status === 'SUCCEEDED' ? pi.amount_received : pi.amount;
          await tx.payment.upsert({
            where: { stripePaymentIntentId: pi.id },
            create: {
              orderId: order.id,
              stripePaymentIntentId: pi.id,
              amount,
              currency: pi.currency,
              status,
            },
            update: { amount, currency: pi.currency, status },
          });
        }
      }

      if (pi && snapshot.refunds) {
        const payment = await tx.payment.findUnique({ where: { stripePaymentIntentId: pi.id } });
        if (!payment) {
          throw new PermanentProcessingError(`Refunds for ${pi.id}, which has no recorded payment`);
        }
        for (const refund of snapshot.refunds) {
          const status = toRefundStatus(refund.status);
          await tx.refund.upsert({
            where: { stripeRefundId: refund.id },
            create: {
              paymentId: payment.id,
              stripeRefundId: refund.id,
              amount: refund.amount,
              currency: refund.currency,
              status,
            },
            update: { amount: refund.amount, currency: refund.currency, status },
          });
        }
      }

      const [payments, refunds] = await Promise.all([
        tx.payment.findMany({ where: { orderId: order.id } }),
        tx.refund.findMany({ where: { payment: { orderId: order.id } } }),
      ]);
      const status = deriveOrderStatus({
        checkoutExpired: order.status === 'EXPIRED' || snapshot.session?.status === 'expired',
        payments,
        refunds,
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status,
          // Fill in the session ID if saving it failed in stage 3's checkout request.
          stripeCheckoutSessionId: order.stripeCheckoutSessionId ?? snapshot.session?.id,
        },
      });

      await tx.stripeEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', attempts: attempt, lastError: null, processedAt: new Date() },
      });
    });
  }

  /** Fetches the current Stripe objects an event refers to. The event type only says what to fetch. */
  private async fetchSnapshot(event: StoredEvent): Promise<Snapshot> {
    const object = (event.payload as { data?: { object?: Record<string, unknown> } } | null)?.data
      ?.object;
    const objectId = typeof object?.id === 'string' ? object.id : undefined;
    if (!objectId) {
      throw new PermanentProcessingError(`Event ${event.id} has no data.object.id`);
    }

    const context = { eventId: event.id };
    return withStripeErrors(async () => {
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.expired': {
          const session = await this.stripeCalls.run('checkout.sessions.retrieve', context, () =>
            this.stripe.checkout.sessions.retrieve(objectId, { expand: ['payment_intent'] }),
          );
          const paymentIntent =
            typeof session.payment_intent === 'object' && session.payment_intent
              ? session.payment_intent
              : undefined;
          return {
            orderId: orderIdFrom(session.metadata, session.client_reference_id, event.id),
            session,
            paymentIntent,
          };
        }
        case 'payment_intent.payment_failed':
        case 'payment_intent.canceled': {
          const paymentIntent = await this.stripeCalls.run('paymentIntents.retrieve', context, () =>
            this.stripe.paymentIntents.retrieve(objectId),
          );
          return { orderId: orderIdFrom(paymentIntent.metadata, null, event.id), paymentIntent };
        }
        case 'charge.refunded':
        case 'refund.updated': {
          // A charge or a refund: both point at their payment intent.
          const piRef = object?.payment_intent;
          const piId = typeof piRef === 'string' ? piRef : (piRef as { id?: string } | null)?.id;
          if (!piId) {
            throw new PermanentProcessingError(`Event ${event.id} has no payment intent`);
          }
          const paymentIntent = await this.stripeCalls.run('paymentIntents.retrieve', context, () =>
            this.stripe.paymentIntents.retrieve(piId),
          );
          const refunds = await this.listRefunds(piId, context);
          return {
            orderId: orderIdFrom(paymentIntent.metadata, null, event.id),
            paymentIntent,
            refunds,
          };
        }
        default:
          throw new PermanentProcessingError(`No handler for event type ${event.type}`);
      }
    });
  }

  /**
   * Every refund of a payment intent, across all pages, so the refunded total is complete. Pages are
   * fetched one by one (not with `autoPagingToArray`) so each page is a logged call.
   */
  private async listRefunds(
    paymentIntentId: string,
    context: { eventId: string },
  ): Promise<Stripe.Refund[]> {
    const refunds: Stripe.Refund[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_REFUND_PAGES; page++) {
      const result = await this.stripeCalls.run('refunds.list', context, () =>
        this.stripe.refunds.list({
          payment_intent: paymentIntentId,
          limit: REFUND_PAGE_SIZE,
          starting_after: startingAfter,
        }),
      );
      refunds.push(...result.data);
      if (!result.has_more || result.data.length === 0) {
        return refunds;
      }
      startingAfter = result.data[result.data.length - 1].id;
    }
    throw new PermanentProcessingError(
      `${paymentIntentId} has more than ${MAX_REFUND_PAGES * REFUND_PAGE_SIZE} refunds`,
    );
  }
}

/** Reads the order ID set in stage 3's metadata; anything else (e.g. `stripe trigger` events) can't match an order. */
function orderIdFrom(
  metadata: Stripe.Metadata | null,
  clientReferenceId: string | null,
  eventId: string,
): string {
  const orderId = metadata?.order_id ?? clientReferenceId ?? undefined;
  if (!orderId || !UUID.test(orderId)) {
    throw new PermanentProcessingError(`Event ${eventId} has no valid order_id in its metadata`);
  }
  return orderId;
}

/** Refuses Stripe amounts or currencies that don't match the order: a sign of tampering or a bug. */
function checkMatchesOrder(
  order: { id: string; amount: number; currency: string },
  currency: string | null,
  amount: number | null,
  source: string,
): void {
  if (currency !== order.currency || amount !== order.amount) {
    throw new PermanentProcessingError(
      `The ${source} charges ${amount} ${currency} but order ${order.id} is ${order.amount} ${order.currency}`,
    );
  }
}

/**
 * Turns Stripe "invalid request" errors (such as an object that doesn't exist) into permanent errors.
 * Rate limits, connection problems and Stripe server errors stay retryable.
 */
async function withStripeErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if ((error as { type?: string }).type === 'StripeInvalidRequestError') {
      throw new PermanentProcessingError(
        `Stripe rejected the request: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}
