import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  RECONCILIATION_QUEUE,
  RECONCILIATION_SCHEDULER_ID,
  STRIPE_EVENTS_QUEUE,
  type StripeEventJob,
} from './../src/queue/queue.module.js';
import { STRIPE_CLIENT } from './../src/stripe/stripe.module.js';
import { WorkerModule } from './../src/worker/worker.module.js';

// Runs a real BullMQ worker on the test Redis and the test database, with a fake Stripe client.
// WORKER_ENABLED is false for the e2e suite, so this file adds the worker module itself.
describe('Stripe events worker (e2e)', () => {
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orderIds: string[] = [];
  const eventIds: string[] = [];
  const paymentIntents = new Map<string, object>();
  const retrievePaymentIntent = vi.fn((id: string) => Promise.resolve(paymentIntents.get(id)));
  const sessions = new Map<string, { payment_intent: string } & Record<string, unknown>>();
  const fakeStripe = {
    paymentIntents: { retrieve: retrievePaymentIntent },
    checkout: {
      sessions: {
        retrieve: (id: string) => {
          const session = sessions.get(id)!;
          return Promise.resolve({
            ...session,
            payment_intent: paymentIntents.get(session.payment_intent),
          });
        },
      },
    },
    refunds: { list: () => Promise.resolve({ data: [], has_more: false }) },
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue<StripeEventJob>;
  let n = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, WorkerModule] })
      .overrideProvider(STRIPE_CLIENT)
      .useValue(fakeStripe)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    queue = app.get<Queue<StripeEventJob>>(getQueueToken(STRIPE_EVENTS_QUEUE));
    await queue.obliterate({ force: true });
  });

  beforeEach(() => {
    // Failures are logged on purpose; keep the output readable.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    retrievePaymentIntent.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma?.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma?.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma?.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
    await queue?.obliterate({ force: true });
    // The worker module also registers the daily reconciliation scheduler; leave Redis clean.
    const reconciliation = app?.get<Queue>(getQueueToken(RECONCILIATION_QUEUE));
    await reconciliation?.removeJobScheduler(RECONCILIATION_SCHEDULER_ID);
    await reconciliation?.obliterate({ force: true });
    await app?.close();
  });

  /** A PENDING order, a succeeded payment intent for it, and a stored event pointing at it. */
  async function paidOrderEvent(metadata?: Record<string, string>) {
    const order = await prisma.order.create({
      data: { courseId: 'nestjs-fundamentals', amount: 4900, currency: 'usd' },
    });
    orderIds.push(order.id);
    const piId = `pi_test_${run}_${++n}`;
    paymentIntents.set(piId, {
      id: piId,
      amount: 4900,
      amount_received: 4900,
      currency: 'usd',
      status: 'succeeded',
      last_payment_error: null,
      metadata: metadata ?? { order_id: order.id },
    });
    const eventId = `evt_test_${run}_${n}`;
    eventIds.push(eventId);
    await prisma.stripeEvent.create({
      data: {
        id: eventId,
        type: 'payment_intent.payment_failed',
        payload: { id: eventId, data: { object: { id: piId } } },
        stripeCreatedAt: new Date(),
      },
    });
    return { orderId: order.id, eventId };
  }

  /** Adds the job like the webhook does, but with a 50 ms backoff so retries don't take minutes. */
  const enqueue = (eventId: string) =>
    queue.add(
      'stripe-event',
      { eventId },
      { jobId: eventId, attempts: 5, backoff: { type: 'fixed', delay: 50 } },
    );

  /** Waits until the job has completed or failed for good. */
  async function settled(eventId: string): Promise<Job<StripeEventJob>> {
    for (let i = 0; i < 200; i++) {
      const state = await queue.getJobState(eventId);
      // Read the job only after it has finished; a copy read earlier can miss the last attempt.
      if (state === 'completed' || state === 'failed') return (await queue.getJob(eventId))!;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Job ${eventId} did not finish within 10 seconds`);
  }

  it('processes an event: payment recorded, order PAID, event PROCESSED on attempt 1', async () => {
    const { orderId, eventId } = await paidOrderEvent();

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('completed');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PROCESSED',
      attempts: 1,
    });
  });

  it('retries after a database failure and completes on the next attempt', async () => {
    const { orderId, eventId } = await paidOrderEvent();
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('Connection refused'));

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('completed');
    // Once a job has finished, attemptsMade counts every attempt, the successful one included.
    expect(job.attemptsMade).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PROCESSED',
      attempts: 2,
      lastError: null,
    });
  });

  it('logs a failure to load the event (database down) and retries', async () => {
    const { orderId, eventId } = await paidOrderEvent();
    vi.spyOn(prisma.stripeEvent, 'findUnique').mockRejectedValueOnce(
      new Error('Connection refused'),
    );

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('completed');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Event ${eventId} failed on attempt 1, will retry`),
    );
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
  });

  it('gives up after 5 failed attempts and marks the event FAILED with the error', async () => {
    const { orderId, eventId } = await paidOrderEvent();
    vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Connection refused'));

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(5);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'FAILED',
      attempts: 5,
      lastError: 'Error: Connection refused',
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'PENDING',
    );
  });

  it('fails a permanent error at once, without retries', async () => {
    const { eventId } = await paidOrderEvent({}); // no order_id, like a `stripe trigger` event

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    const event = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(event.lastError).toContain('no valid order_id');
  });

  it('skips an event that is already PROCESSED without calling Stripe', async () => {
    const { eventId } = await paidOrderEvent();
    await prisma.stripeEvent.update({ where: { id: eventId }, data: { status: 'PROCESSED' } });

    await enqueue(eventId);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('completed');
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  /** Clicks the dashboard's retry button: the same API call the Bull Board page sends. */
  const retryFromDashboard = (eventId: string) =>
    request(app.getHttpServer())
      .put(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/${eventId}/retry`)
      .auth('admin', 'e2e-dashboard-password');

  it('a dashboard retry after 5 failures runs as attempt 6 and completes', async () => {
    const { orderId, eventId } = await paidOrderEvent();
    const outage = vi
      .spyOn(prisma, '$transaction')
      .mockRejectedValue(new Error('Connection refused'));
    await enqueue(eventId);
    expect(await (await settled(eventId)).getState()).toBe('failed');
    outage.mockRestore();

    await retryFromDashboard(eventId).expect(204);
    const job = await settled(eventId);

    // Bull Board doesn't reset attemptsMade, so the manual retry is attempt 6 and the event keeps its count.
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(6);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PROCESSED',
      attempts: 6,
      lastError: null,
    });
  });

  it('a dashboard retry that fails again gets one attempt, not five more', async () => {
    const { eventId } = await paidOrderEvent();
    vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Connection refused'));
    await enqueue(eventId);
    await settled(eventId);

    await retryFromDashboard(eventId).expect(204);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(6);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'FAILED',
      attempts: 6,
    });
  });

  it('a dashboard retry of a completed job changes nothing and does not call Stripe again', async () => {
    const { eventId } = await paidOrderEvent();
    await enqueue(eventId);
    await settled(eventId);
    expect(retrievePaymentIntent).toHaveBeenCalledTimes(1);

    await retryFromDashboard(eventId).expect(204);
    const job = await settled(eventId);

    expect(await job.getState()).toBe('completed');
    expect(retrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PROCESSED',
      attempts: 1,
    });
  });

  /** A paid Checkout Session at Stripe whose payment is missing from the database. */
  async function missingPayment() {
    const { orderId, eventId } = await paidOrderEvent();
    const piId = `pi_test_${run}_${n}`;
    const sessionId = `cs_test_${run}_${++n}`;
    sessions.set(sessionId, {
      id: sessionId,
      status: 'complete',
      currency: 'usd',
      amount_total: 4900,
      metadata: { order_id: orderId },
      client_reference_id: orderId,
      payment_intent: piId,
    });
    return { orderId, eventId, sessionId };
  }

  /** Adds a repair job like reconciliation does, with the fast test backoff. */
  const enqueueRepair = (sessionId: string) =>
    queue.add('reconcile-session' as never, { sessionId } as never, {
      jobId: `reconcile-${sessionId}-${Date.now()}`,
      attempts: 5,
      backoff: { type: 'fixed', delay: 50 },
    });

  it('a reconcile-session job writes the missing payment and marks the order PAID', async () => {
    const { orderId, eventId, sessionId } = await missingPayment();

    const job = await enqueueRepair(sessionId);
    await settled(job.id!);

    expect(await queue.getJobState(job.id!)).toBe('completed');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
    expect(await prisma.payment.findMany({ where: { orderId } })).toMatchObject([
      { amount: 4900, currency: 'usd', status: 'SUCCEEDED' },
    ]);
    // The repair doesn't touch stripe_events: the stored event is still PENDING and unattempted.
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
  });

  it('a reconcile-session job that fails once is retried and completes', async () => {
    const { orderId, sessionId } = await missingPayment();
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('Connection refused'));

    const job = await enqueueRepair(sessionId);
    const done = await settled(job.id!);

    expect(await done.getState()).toBe('completed');
    expect(done.attemptsMade).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
  });

  it.each([
    ['an unknown job name', 'surprise', { eventId: 'evt_x' }],
    ['a stripe-event job without eventId', 'stripe-event', {}],
    ['a reconcile-session job without sessionId', 'reconcile-session', { eventId: 'evt_x' }],
  ])('fails %s at once, without retries', async (_case, name, data) => {
    const jobId = `bad-${run}-${++n}`;
    await queue.add(name as never, data as never, {
      jobId,
      attempts: 5,
      backoff: { type: 'fixed', delay: 50 },
    });

    const job = await settled(jobId);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toContain('unknown name or data');
  });
});
