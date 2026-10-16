import type Stripe from 'stripe';
import { findOrderId } from '../worker/mapping.js';

/** How far back each run looks: the brief's "last 2 days", in seconds. */
export const RECONCILIATION_WINDOW_SECONDS = 2 * 24 * 60 * 60;

/** The fields of a listed Checkout Session the selection needs. */
export type ListedSession = Pick<
  Stripe.Checkout.Session,
  'id' | 'payment_status' | 'payment_intent' | 'metadata' | 'client_reference_id'
>;

/** Counts for the run's log line and its return value on the dashboard. */
export interface ReconciliationSummary {
  /** Completed sessions Stripe listed in the window. */
  checked: number;
  /** Complete but not paid (e.g. a free order or a payment method that settles later). */
  notPaid: number;
  /** No valid `order_id`: not created by this app's checkout (e.g. `stripe trigger`). */
  noOrderId: number;
  /** An `order_id` that isn't in the database. */
  unknownOrder: number;
  /** Paid, and the database already has a SUCCEEDED payment for it. */
  alreadyRecorded: number;
  /** Paid at Stripe, missing from the database: one repair job queued for each. */
  missing: number;
}

/**
 * Start of the window, in Unix seconds as Stripe's `created` filter expects (not milliseconds).
 * @param now The time of the run.
 */
export function windowStart(now: Date): number {
  return Math.floor(now.getTime() / 1000) - RECONCILIATION_WINDOW_SECONDS;
}

/** The payment intent ID of a session, whether Stripe returned it as an ID or an expanded object. */
export function paymentIntentIdOf(
  session: Pick<ListedSession, 'payment_intent'>,
): string | undefined {
  const pi = session.payment_intent;
  return typeof pi === 'string' ? pi : (pi?.id ?? undefined);
}

/**
 * Picks the sessions whose payment is missing from the database: paid at Stripe, belonging to an
 * order that exists, and with no SUCCEEDED payment for their payment intent. Everything else is
 * counted under the reason it was skipped.
 * @param sessions Completed sessions from Stripe.
 * @param knownOrderIds Order IDs that exist in the database.
 * @param recordedPaymentIntentIds Payment intents that have a SUCCEEDED payment row.
 */
export function selectMissing(
  sessions: ListedSession[],
  knownOrderIds: ReadonlySet<string>,
  recordedPaymentIntentIds: ReadonlySet<string>,
): { missing: ListedSession[]; summary: ReconciliationSummary } {
  const summary: ReconciliationSummary = {
    checked: sessions.length,
    notPaid: 0,
    noOrderId: 0,
    unknownOrder: 0,
    alreadyRecorded: 0,
    missing: 0,
  };
  const missing: ListedSession[] = [];

  for (const session of sessions) {
    const paymentIntentId = paymentIntentIdOf(session);
    const orderId = findOrderId(session.metadata, session.client_reference_id);
    if (session.payment_status !== 'paid' || !paymentIntentId) {
      summary.notPaid++;
    } else if (!orderId) {
      summary.noOrderId++;
    } else if (!knownOrderIds.has(orderId)) {
      summary.unknownOrder++;
    } else if (recordedPaymentIntentIds.has(paymentIntentId)) {
      summary.alreadyRecorded++;
    } else {
      summary.missing++;
      missing.push(session);
    }
  }
  return { missing, summary };
}
