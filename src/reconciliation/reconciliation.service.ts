import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  RECONCILE_SESSION_JOB,
  STRIPE_EVENT_JOB,
  STRIPE_EVENTS_QUEUE,
  type ReconcileSessionJob,
  type StripeEventJob,
} from '../queue/queue.module.js';
import { StripeCalls } from '../stripe/stripe-calls.js';
import { STRIPE_CLIENT } from '../stripe/stripe.module.js';
import { findOrderId } from '../worker/mapping.js';
import {
  type ListedSession,
  paymentIntentIdOf,
  type ReconciliationSummary,
  selectMissing,
  windowStart,
} from './missing-payments.js';

/** Sessions per page, Stripe's maximum. */
const SESSION_PAGE_SIZE = 100;

/** Stops a runaway pagination loop: 100 pages is 10,000 checkouts in 2 days. */
const MAX_SESSION_PAGES = 100;

/** How old a `PENDING` event must be before a missing job counts as lost: 1 hour. */
export const LOST_EVENT_AGE_MS = 60 * 60 * 1000;

/** Lost events queued again per run; the next run takes the rest. */
const MAX_REQUEUED_EVENTS = 1000;

/**
 * Compares the last 2 days of completed Stripe checkouts with the database and queues a repair job
 * for every paid one whose payment is missing. Also queues again stored events whose job was lost.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly stripeCalls: StripeCalls,
    @InjectQueue(STRIPE_EVENTS_QUEUE)
    private readonly queue: Queue<ReconcileSessionJob | StripeEventJob>,
  ) {}

  /**
   * Runs one reconciliation.
   * @param now The time of the run; the window is the 2 days before it. A parameter so tests can pin it.
   * @returns The counts, also logged as one line.
   */
  async run(now: Date = new Date()): Promise<ReconciliationSummary> {
    const sessions = await this.listCompletedSessions(windowStart(now));

    const orderIds = [
      ...new Set(sessions.flatMap((s) => findOrderId(s.metadata, s.client_reference_id) ?? [])),
    ];
    const paymentIntentIds = [...new Set(sessions.flatMap((s) => paymentIntentIdOf(s) ?? []))];
    // Two queries for the whole run, not one per session.
    const [orders, payments, openIssues, openIssuesTotal] = await Promise.all([
      this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true } }),
      this.prisma.payment.findMany({
        where: { stripePaymentIntentId: { in: paymentIntentIds }, status: 'SUCCEEDED' },
        select: { stripePaymentIntentId: true },
      }),
      this.prisma.reconciliationIssue.findMany({
        where: { stripeCheckoutSessionId: { in: sessions.map((s) => s.id) }, resolvedAt: null },
        select: { stripeCheckoutSessionId: true },
      }),
      this.prisma.reconciliationIssue.count({ where: { resolvedAt: null } }),
    ]);

    const selection = selectMissing(
      sessions,
      new Set(orders.map((o) => o.id)),
      new Set(payments.map((p) => p.stripePaymentIntentId)),
      new Set(openIssues.map((i) => i.stripeCheckoutSessionId)),
    );
    const missing = selection.missing;

    // The run's timestamp makes each job ID unique per run: a repair queued yesterday that is still
    // kept in Redis doesn't block today's. Repairs are idempotent, so a duplicate is harmless.
    // BullMQ refuses ":" in custom IDs, hence "-".
    const runId = now.getTime();
    await this.queue.addBulk(
      missing.map((session) => ({
        name: RECONCILE_SESSION_JOB,
        data: { sessionId: session.id },
        opts: { jobId: `reconcile-${session.id}-${runId}` },
      })),
    );
    const requeued = await this.requeueLostEvents(now);
    const summary: ReconciliationSummary = { ...selection.summary, openIssuesTotal, requeued };

    this.logger.log(
      `Reconciliation: checked ${summary.checked} completed sessions, ${summary.missing} missing and queued, ` +
        `${summary.alreadyRecorded} already recorded, skipped ${summary.notPaid} not paid, ` +
        `${summary.noOrderId} without order ID, ${summary.unknownOrder} with unknown order, ` +
        `${summary.openIssues} with an open issue; ${summary.requeued} lost event(s) queued again`,
    );
    if (openIssuesTotal > 0) {
      this.logger.warn(
        `${openIssuesTotal} open reconciliation issue(s) need review (table reconciliation_issues)`,
      );
    }
    for (const session of missing) {
      this.logger.warn(`Payment missing for Checkout Session ${session.id}; repair queued`);
    }
    return summary;
  }

  /**
   * Queues again the stored events whose job is gone from Redis (lost data, a flushed database, an
   * emptied queue). Without this such an event stays `PENDING` for good: the webhook already answered
   * 200, so Stripe won't send it again, and the session check above only finds missing payments, not
   * refunds or failures. Only events received over {@link LOST_EVENT_AGE_MS} ago, so one whose job is
   * being added right now isn't touched. An event whose job still exists, in any state, is left alone.
   * @param now The time of the run.
   * @returns How many events were queued again.
   */
  private async requeueLostEvents(now: Date): Promise<number> {
    const pending = await this.prisma.stripeEvent.findMany({
      where: { status: 'PENDING', receivedAt: { lt: new Date(now.getTime() - LOST_EVENT_AGE_MS) } },
      select: { id: true },
      orderBy: { receivedAt: 'asc' },
      take: MAX_REQUEUED_EVENTS,
    });
    let requeued = 0;
    for (const { id } of pending) {
      if (await this.queue.getJob(id)) {
        continue;
      }
      // Same name, data and job ID as the webhook's add (WebhooksService.recordEvent).
      await this.queue.add(STRIPE_EVENT_JOB, { eventId: id }, { jobId: id });
      this.logger.warn(`Event ${id} was PENDING with no job; queued again`);
      requeued++;
    }
    return requeued;
  }

  /** Every completed session created since `createdSince` (Unix seconds), page by page. */
  private async listCompletedSessions(createdSince: number): Promise<ListedSession[]> {
    const sessions: ListedSession[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const result = await this.stripeCalls.run(
        'checkout.sessions.list',
        { job: 'reconciliation' },
        () =>
          this.stripe.checkout.sessions.list({
            status: 'complete',
            created: { gte: createdSince },
            limit: SESSION_PAGE_SIZE,
            starting_after: startingAfter,
          }),
      );
      sessions.push(...result.data);
      if (!result.has_more || result.data.length === 0) {
        return sessions;
      }
      startingAfter = result.data[result.data.length - 1].id;
    }
    throw new Error(`More than ${MAX_SESSION_PAGES * SESSION_PAGE_SIZE} sessions in the window`);
  }
}
