import type Stripe from 'stripe';
import type { OrderStatus, PaymentStatus, RefundStatus } from '../generated/prisma/enums.js';

/**
 * A problem that retrying can't fix, such as an event for an order that doesn't exist.
 * The worker fails the job at once instead of using up its retries, and saves the message on the event.
 */
export class PermanentProcessingError extends Error {
  override readonly name = 'PermanentProcessingError';
}

/**
 * Maps a Stripe payment intent to the status of its `payments` row.
 * @param paymentIntent The payment intent as fetched from Stripe now, not as the event described it.
 * @returns The payment status, or `null` while the payment is still in progress (no row is written:
 *   a payment that is neither done nor failed has nothing to record yet).
 */
export function toPaymentStatus(
  paymentIntent: Pick<Stripe.PaymentIntent, 'status' | 'last_payment_error'>,
): PaymentStatus | null {
  switch (paymentIntent.status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'canceled':
      return 'CANCELED';
    case 'requires_payment_method':
      // Back to "needs a payment method" after an attempt: the last card was declined.
      // Without an error, the customer simply hasn't paid yet.
      return paymentIntent.last_payment_error ? 'FAILED' : null;
    default:
      return null;
  }
}

/**
 * Maps a Stripe refund status to the status of its `refunds` row.
 * `requires_action` (the customer must do something, rare for cards) counts as pending; an unknown
 * future status also counts as pending, so it is never mistaken for money returned.
 * @param status The refund's `status` from Stripe.
 */
export function toRefundStatus(status: string | null): RefundStatus {
  switch (status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'PENDING';
  }
}

/** Everything the order status depends on. */
export interface OrderFacts {
  /** True once the checkout session expired (the order was `EXPIRED`, or Stripe says so now). */
  checkoutExpired: boolean;
  payments: ReadonlyArray<{ status: PaymentStatus; amount: number }>;
  refunds: ReadonlyArray<{ status: RefundStatus; amount: number }>;
}

/**
 * Computes an order's status from its payments, refunds and checkout state, instead of stepping it
 * from event to event. Events can arrive in any order and the result is the same.
 * - Money paid: `PAID`, `PARTIALLY_REFUNDED` or `REFUNDED`, from succeeded refunds vs succeeded payments.
 * - Nothing paid: `EXPIRED` once the checkout expired (it stays expired, even if a later
 *   `payment_intent.canceled` arrives), else `PAYMENT_FAILED` after a declined card, else `PENDING`.
 * @throws PermanentProcessingError when succeeded refunds add up to more than was paid; Stripe never
 *   allows that, so the data is inconsistent and must be looked at.
 */
export function deriveOrderStatus(facts: OrderFacts): OrderStatus {
  const paid = sum(facts.payments, 'SUCCEEDED');
  const refunded = sum(facts.refunds, 'SUCCEEDED');

  if (refunded > paid) {
    throw new PermanentProcessingError(
      `Refunds (${refunded}) exceed the amount paid (${paid})`,
    );
  }
  if (paid > 0) {
    if (refunded === 0) return 'PAID';
    return refunded === paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }
  if (facts.checkoutExpired) return 'EXPIRED';
  if (facts.payments.some((p) => p.status === 'FAILED')) return 'PAYMENT_FAILED';
  return 'PENDING';
}

function sum(rows: ReadonlyArray<{ status: string; amount: number }>, status: string): number {
  return rows.filter((row) => row.status === status).reduce((total, row) => total + row.amount, 0);
}
