import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import type Stripe from 'stripe';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  RECONCILE_SESSION_JOB,
  STRIPE_EVENTS_QUEUE,
  type ReconcileSessionJob,
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
  let n = 0;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let queue: Queue<ReconcileSessionJob>;
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
    queue = app.get<Queue<ReconcileSessionJob>>(getQueueToken(STRIPE_EVENTS_QUEUE));
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
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
    (await queue.getJobs(['waiting'])).map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
    }));

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

  it('queues nothing when every payment is recorded', async () => {
    await paidSession(true);

    expect((await service.run()).missing).toBe(0);
    expect(await queuedRepairs()).toEqual([]);
  });
});
