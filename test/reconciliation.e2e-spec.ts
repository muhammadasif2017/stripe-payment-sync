import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import type Stripe from 'stripe';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  RECONCILE_SESSION_JOB,
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_JOB_OPTIONS,
  STRIPE_EVENTS_QUEUE,
  type ReconcileSessionJob,
  type StripeEventJob,
} from './../src/queue/queue.module.js';
import { windowStart } from './../src/reconciliation/missing-payments.js';
import { ReconciliationService } from './../src/reconciliation/reconciliation.service.js';
import { StripeCalls } from './../src/stripe/stripe-calls.js';
import { createTestApp } from './create-test-app.js';

// The reconciliation run against the test database and test Redis, with a fake Stripe client.
// WORKER_ENABLED is false here, so queued repair jobs stay waiting for the test to inspect.
describe('Reconciliation run (e2e)', () => {
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orderIds: string[] = [];
  const eventIds: string[] = [];
  let n = 0;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue<ReconcileSessionJob | StripeEventJob>;
  let service: ReconciliationService;

  // What the fake `checkout.sessions.list` returns, and how it was called.
  let listed: Partial<Stripe.Checkout.Session>[] = [];
  let pageSize: number | undefined;
  const listCalls: Stripe.Checkout.SessionListParams[] = [];
  const fakeStripe = {
    checkout: {
      sessions: {
        list: (params: Stripe.Checkout.SessionListParams) => {
          listCalls.push(params);
          const start = params.starting_after
            ? listed.findIndex((s) => s.id === params.starting_after) + 1
            : 0;
          const limit = pageSize ?? params.limit!;
          return Promise.resolve({
            data: listed.slice(start, start + limit),
            has_more: start + limit < listed.length,
          });
        },
      },
    },
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    queue = app.get<Queue<ReconcileSessionJob | StripeEventJob>>(
      getQueueToken(STRIPE_EVENTS_QUEUE),
    );
    await queue.obliterate({ force: true });
    service = new ReconciliationService(
      prisma,
      fakeStripe as unknown as Stripe,
      new StripeCalls(),
      queue,
    );
  });

  beforeEach(async () => {
    listed = [];
    pageSize = undefined;
    listCalls.length = 0;
    await queue.obliterate({ force: true });
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Deleted after each test, so a later test's run doesn't find them PENDING with no job.
    await prisma.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
  });

  afterAll(async () => {
    await prisma?.reconciliationIssue.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma?.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma?.order.deleteMany({ where: { id: { in: orderIds } } });
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  /** An order and a paid session for it; `recorded` also saves its SUCCEEDED payment. */
  async function paidSession(recorded: boolean) {
    const order = await prisma.order.create({
      data: { courseId: 'nestjs-fundamentals', amount: 4900, currency: 'usd', status: 'PAID' },
    });
    orderIds.push(order.id);
    const piId = `pi_test_${run}_${++n}`;
    if (recorded) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          stripePaymentIntentId: piId,
          amount: 4900,
          currency: 'usd',
          status: 'SUCCEEDED',
        },
      });
    }
    const session = {
      id: `cs_test_${run}_${n}`,
      payment_status: 'paid' as const,
      payment_intent: piId,
      metadata: { order_id: order.id },
      client_reference_id: order.id,
    };
    listed.push(session);
    return session;
  }

  const queuedRepairs = async () =>
    (await queue.getJobs(['waiting']))
      .filter((job) => job.name === RECONCILE_SESSION_JOB)
      .map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data as ReconcileSessionJob,
      }));

  /** A stored event that arrived `minutesAgo` (the trigger sets `received_at`, so it's moved after). */
  async function storedEvent(minutesAgo: number, status: 'PENDING' | 'PROCESSED' = 'PENDING') {
    const id = `evt_test_${run}_${++n}`;
    eventIds.push(id);
    await prisma.stripeEvent.create({
      data: {
        id,
        type: 'charge.refunded',
        payload: { id, data: { object: { id: `ch_test_${run}_${n}` } } },
        status,
        stripeCreatedAt: new Date(),
      },
    });
    await prisma.$executeRaw`
      UPDATE stripe_events SET received_at = now() - make_interval(mins => ${minutesAgo})
      WHERE id = ${id}`;
    return id;
  }

  it('queues a repair for a paid session whose payment is missing, and only for that one', async () => {
    const missing = await paidSession(false);
    await paidSession(true);
    listed.push({
      id: `cs_test_${run}_trigger`,
      payment_status: 'paid',
      payment_intent: 'pi_trigger',
      metadata: {},
      client_reference_id: null,
    });
    const now = new Date();

    const summary = await service.run(now);

    expect(summary).toEqual({
      checked: 3,
      missing: 1,
      alreadyRecorded: 1,
      noOrderId: 1,
      notPaid: 0,
      unknownOrder: 0,
      openIssues: 0,
      openIssuesTotal: expect.any(Number),
      requeued: 0,
    });
    expect(await queuedRepairs()).toEqual([
      {
        id: `reconcile-${missing.id}-${now.getTime()}`,
        name: RECONCILE_SESSION_JOB,
        data: { sessionId: missing.id },
      },
    ]);
  });

  it('asks Stripe for completed sessions of the last 2 days, in seconds', async () => {
    const now = new Date('2026-10-16T03:00:00Z');

    await service.run(now);

    expect(listCalls[0]).toMatchObject({
      status: 'complete',
      created: { gte: windowStart(now) },
      limit: 100,
    });
    expect((listCalls[0].created as { gte: number }).gte).toBe(1_791_946_800);
  });

  it('reads every page of sessions', async () => {
    await paidSession(true);
    await paidSession(true);
    const last = await paidSession(false);
    pageSize = 2;

    const summary = await service.run();

    expect(listCalls).toHaveLength(2);
    expect(summary).toMatchObject({ checked: 3, alreadyRecorded: 2, missing: 1 });
    expect((await queuedRepairs()).map((job) => job.data.sessionId)).toEqual([last.id]);
  });

  it('queues again on the next run, with a new job ID', async () => {
    const missing = await paidSession(false);

    await service.run(new Date(1_000_000));
    await service.run(new Date(2_000_000));

    expect((await queuedRepairs()).map((job) => job.id).sort()).toEqual([
      `reconcile-${missing.id}-1000000`,
      `reconcile-${missing.id}-2000000`,
    ]);
  });

  it('skips a session with an open issue, reports it, and retries it once resolved', async () => {
    const stuck = await paidSession(false);
    const issue = await prisma.reconciliationIssue.create({
      data: {
        stripeCheckoutSessionId: stuck.id,
        orderId: stuck.metadata.order_id,
        reason: 'The session charges 9900 usd but order … is 4900 usd',
      },
    });
    const warn = vi.mocked(Logger.prototype.warn);

    const first = await service.run(new Date(3_000_000));

    expect(first).toMatchObject({ missing: 0, openIssues: 1 });
    expect(first.openIssuesTotal).toBeGreaterThanOrEqual(1);
    expect(await queuedRepairs()).toEqual([]);
    expect(warn.mock.calls.some(([line]) => String(line).includes('need review'))).toBe(true);

    await prisma.reconciliationIssue.update({
      where: { id: issue.id },
      data: { resolvedAt: new Date() },
    });
    const second = await service.run(new Date(4_000_000));

    expect(second).toMatchObject({ missing: 1, openIssues: 0 });
    expect((await queuedRepairs()).map((job) => job.id)).toEqual([`reconcile-${stuck.id}-4000000`]);
  });

  it('repairs a paid session whose only recorded payment is a FAILED attempt', async () => {
    // A declined card first, then a successful payment whose event was lost: the row on file is the
    // failed attempt, which must not count as the payment being recorded.
    const session = await paidSession(false);
    await prisma.payment.create({
      data: {
        orderId: session.metadata.order_id,
        stripePaymentIntentId: session.payment_intent,
        amount: 4900,
        currency: 'usd',
        status: 'FAILED',
      },
    });

    const summary = await service.run();

    expect(summary).toMatchObject({ missing: 1, alreadyRecorded: 0 });
    expect((await queuedRepairs()).map((job) => job.data)).toEqual([{ sessionId: session.id }]);
  });

  it('queues again an event left PENDING over an hour with no job, and only that one', async () => {
    const lost = await storedEvent(61);
    const recent = await storedEvent(5);
    const queued = await storedEvent(120);
    await queue.add(STRIPE_EVENT_JOB, { eventId: queued }, { jobId: queued, delay: 60_000 });
    await storedEvent(120, 'PROCESSED');

    const summary = await service.run();

    expect(summary.requeued).toBe(1);
    const job = await queue.getJob(lost);
    expect(job).toMatchObject({ name: STRIPE_EVENT_JOB, data: { eventId: lost } });
    // The queue's job options apply, as for a job the webhook adds.
    expect(job!.opts.attempts).toBe(STRIPE_EVENT_JOB_OPTIONS.attempts);
    expect(await queue.getJob(recent)).toBeUndefined();
    expect(await queue.getJobState(queued)).toBe('delayed');
  });

  it('queues nothing when every payment is recorded', async () => {
    await paidSession(true);

    expect((await service.run()).missing).toBe(0);
    expect(await queuedRepairs()).toEqual([]);
  });
});
