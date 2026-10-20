import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeCalls, type StripeCallContext } from '../stripe/stripe-calls.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';
import {
  deriveOrderStatus,
  findOrderId,
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

/** The current state of the Stripe objects behind one event or repair, fetched before the transaction. */
interface Snapshot {
  /**
   * Database time just before the first Stripe call. Any change Stripe made before an event was
   * stored is already in Stripe's answer, so events stored before this moment are covered.
   */
  startedAt: Date;
  orderId: string;
  session?: Stripe.Checkout.Session;
  paymentIntent?: Stripe.PaymentIntent;
  refunds?: Stripe.Refund[];
}

/** Refunds fetched per page, Stripe's maximum. */
const REFUND_PAGE_SIZE = 100;

/** Stops a runaway pagination loop: 100 pages is 10,000 refunds, far more than one payment can have. */
const MAX_REFUND_PAGES = 100;

/**
 * Reads of Stripe one job makes before giving up on getting a snapshot newer than the one already
 * saved. Losing more than once means other jobs keep saving newer data, so BullMQ retries it later.
 */
const MAX_SNAPSHOT_READS = 3;

/** Thrown inside the transaction (rolling it back) when a newer snapshot was saved meanwhile. */
class StaleSnapshotError extends Error {}

/**
 * A saved read this far ahead of a new one can't come from a job still running: the database clock
 * went back (or someone set `synced_at` by hand). Until the clock catches up, the order's reads all
 * lose and its jobs fail, so it is logged.
 */
const CLOCK_WARNING_MS = 60_000;

/**
 * Applies Stripe's current state to the database: fetches the latest objects from Stripe, then writes
 * the payment, refunds and order status in one transaction. Used for webhook events (which also mark
 * their `stripe_events` row PROCESSED in that transaction) and for reconciliation repairs (which have
 * no event row).
 */
@Injectable()
export class StripeEventHandler {
  private readonly logger = new Logger(StripeEventHandler.name);

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
    await this.readAndApply(() => this.fetchSnapshot(event), `event ${event.id}`, {
      id: event.id,
      attempt,
    });
  }

  /**
   * Repairs one paid Checkout Session found by reconciliation: fetches the session, its payment intent
   * and all the payment intent's refunds, and writes them like an event would. In the same
   * transaction, the payment's events that never got processed (PENDING or FAILED) are marked
   * RECONCILED. Safe to run any number of times.
   * @param sessionId The Checkout Session (`cs_...`).
   * @returns The IDs of the events marked RECONCILED, so their failed jobs can be cleared.
   * @throws PermanentProcessingError when retrying can't help (no matching order, amounts that don't
   *   match, a session Stripe says doesn't exist); any other error is worth retrying.
   */
  async reconcileSession(sessionId: string): Promise<string[]> {
    const context = { job: 'reconciliation' };
    const read = () =>
      withStripeErrors(async (): Promise<Omit<Snapshot, 'startedAt'>> => {
        const session = await this.stripeCalls.run('checkout.sessions.retrieve', context, () =>
          this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] }),
        );
        const paymentIntent =
          typeof session.payment_intent === 'object' && session.payment_intent
            ? session.payment_intent
            : undefined;
        return {
          orderId: orderIdFrom(
            session.metadata,
            session.client_reference_id,
            `Session ${sessionId}`,
          ),
          session,
          paymentIntent,
          // Refunds too, so a restored payment comes back with the right refunded total.
          refunds: paymentIntent ? await this.listRefunds(paymentIntent.id, context) : undefined,
        };
      });
    return this.readAndApply(read, `session ${sessionId}`);
  }

  /**
   * Reads Stripe and saves the result, reading again when another job saved a snapshot that started
   * reading Stripe later than this one. The lock alone isn't enough: it orders the saves, not the
   * reads, so without this check an older read that saves last would overwrite newer data.
   * @param read Fetches the Stripe objects.
   * @throws Error (retryable) when every one of `MAX_SNAPSHOT_READS` reads was older than the saved
   *   one; PermanentProcessingError (with the order ID, when known) as `apply` does.
   */
  private async readAndApply(
    read: () => Promise<Omit<Snapshot, 'startedAt'>>,
    source: string,
    event?: { id: string; attempt: number },
  ): Promise<string[]> {
    for (let reads = 1; ; reads++) {
      const startedAt = await this.databaseNow();
      const snapshot = { startedAt, ...(await read()) };
      try {
        return await this.apply(snapshot, source, event);
      } catch (error) {
        if (error instanceof PermanentProcessingError) {
          error.orderId ??= snapshot.orderId;
        }
        if (!(error instanceof StaleSnapshotError)) {
          throw error;
        }
        if (reads >= MAX_SNAPSHOT_READS) {
          throw new Error(
            `Stripe snapshot for ${source} was older than the one saved for order ${snapshot.orderId} after ${reads} reads`,
          );
        }
      }
    }
  }

  /**
   * Writes a snapshot in one transaction.
   * @param source What the snapshot came from, for error messages.
   * @param event The event to mark PROCESSED in the same transaction; none for a repair.
   * @returns For a repair, the IDs of the events it settled; for an event, an empty list.
   */
  private async apply(
    snapshot: Snapshot,
    source: string,
    event?: { id: string; attempt: number },
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the order row: two jobs for the same order (say, a payment and a refund) wait for each
      // other instead of both computing the status from rows the other is about to change.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${snapshot.orderId}::uuid FOR UPDATE`;
      if (locked.length === 0) {
        throw new PermanentProcessingError(`No order ${snapshot.orderId} for ${source}`);
      }
      const order = await tx.order.findUniqueOrThrow({ where: { id: snapshot.orderId } });
      // Another job saved a snapshot that started reading Stripe at the same time or later: this one
      // may hold older data, so it must not overwrite it. Equal times count as older, so of two reads
      // in the same millisecond the second to save reads again rather than guessing which is newer.
      if (order.syncedAt && snapshot.startedAt <= order.syncedAt) {
        const aheadMs = order.syncedAt.getTime() - snapshot.startedAt.getTime();
        if (aheadMs > CLOCK_WARNING_MS) {
          this.logger.warn(
            `synced_at of order ${order.id} is ${Math.round(aheadMs / 1000)} s ahead of the database clock; its reads can't be saved until the clock passes it`,
          );
        }
        throw new StaleSnapshotError();
      }

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
          syncedAt: snapshot.startedAt,
        },
      });

      if (event) {
        // A repair may have settled the event while this job read Stripe; RECONCILED then stays.
        await tx.stripeEvent.updateMany({
          where: { id: event.id, status: { in: ['PENDING', 'FAILED'] } },
          data: {
            status: 'PROCESSED',
            attempts: event.attempt,
            lastError: null,
            processedAt: new Date(),
          },
        });
        return [];
      }

      // A repair: settle the events about this payment that never got processed, so the history
      // doesn't keep showing them as stuck. Matched on the session or payment intent ID, or on the
      // payment intent a charge or refund event points at. Only events stored before the snapshot
      // started: a later one may describe a change the snapshot missed, so its own job handles it.
      // `last_error` and `attempts` stay as a record of what went wrong. The status condition
      // matches the partial index stripe_events_unsettled_idx, so only the few unsettled rows are
      // read.
      const objectIds = [snapshot.session?.id, pi?.id].filter((id): id is string => Boolean(id));
      const settled = await tx.$queryRaw<{ id: string }[]>`
        UPDATE stripe_events SET status = 'RECONCILED'
        WHERE status <> 'PROCESSED' AND status <> 'RECONCILED'
          AND received_at < ${snapshot.startedAt}
          AND (payload->'data'->'object'->>'id' = ANY(${objectIds})
            OR payload->'data'->'object'->>'payment_intent' = ${pi?.id ?? null})
        RETURNING id`;
      return settled.map((row) => row.id);
    });
  }

  /**
   * The database's clock, not the app's: `received_at` is set by the database (a trigger), and the
   * two can differ. Rounded to milliseconds like `received_at`, so an event stored after this moment never
   * compares as earlier.
   */
  private async databaseNow(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now()::timestamptz(3) AS now`;
    return row.now;
  }

  /** Fetches the current Stripe objects an event refers to. The event type only says what to fetch. */
  private async fetchSnapshot(event: StoredEvent): Promise<Omit<Snapshot, 'startedAt'>> {
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
            orderId: orderIdFrom(
              session.metadata,
              session.client_reference_id,
              `Event ${event.id}`,
            ),
            session,
            paymentIntent,
          };
        }
        case 'payment_intent.payment_failed':
        case 'payment_intent.canceled': {
          const paymentIntent = await this.stripeCalls.run('paymentIntents.retrieve', context, () =>
            this.stripe.paymentIntents.retrieve(objectId),
          );
          return {
            orderId: orderIdFrom(paymentIntent.metadata, null, `Event ${event.id}`),
            paymentIntent,
          };
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
            orderId: orderIdFrom(paymentIntent.metadata, null, `Event ${event.id}`),
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
    context: StripeCallContext,
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

/**
 * Reads the order ID set in stage 3's metadata; anything else (e.g. `stripe trigger` events) can't
 * match an order.
 * @param source What is being processed, for the error message (e.g. "Event evt_...").
 */
function orderIdFrom(
  metadata: Stripe.Metadata | null,
  clientReferenceId: string | null,
  source: string,
): string {
  const orderId = findOrderId(metadata, clientReferenceId);
  if (!orderId) {
    throw new PermanentProcessingError(`${source} has no valid order_id in its metadata`);
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
