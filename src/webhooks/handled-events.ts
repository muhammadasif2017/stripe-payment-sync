import type Stripe from 'stripe';

/**
 * Stripe event types this system acts on: each one changes an order, a payment or a refund.
 * Only these are stored and queued; Stripe still gets 200 for any other type, so it stops resending it.
 * Add a type here only together with its handling in the worker (stage 5).
 */
export const HANDLED_EVENT_TYPES: ReadonlySet<Stripe.Event.Type> = new Set<Stripe.Event.Type>([
  'checkout.session.completed', // customer paid: order PAID, payment recorded
  'checkout.session.expired', // customer never paid: order EXPIRED
  'payment_intent.payment_failed', // card declined: payment FAILED
  'payment_intent.canceled', // payment canceled: payment CANCELED
  'charge.refunded', // full or partial refund issued
  'refund.updated', // refund status changed (e.g. failed or canceled)
]);

/**
 * Tells whether the worker handles this event type.
 * @param type The event's `type`, e.g. `checkout.session.completed`.
 */
export function isHandledEventType(type: string): boolean {
  return HANDLED_EVENT_TYPES.has(type as Stripe.Event.Type);
}
