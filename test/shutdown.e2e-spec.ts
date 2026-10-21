import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  RECONCILIATION_QUEUE,
  RECONCILIATION_SCHEDULER_ID,
  STRIPE_EVENTS_QUEUE,
} from './../src/queue/queue.module.js';
import { STRIPE_CLIENT } from './../src/stripe/stripe.module.js';
import { WorkerModule } from './../src/worker/worker.module.js';
import { createTestPrisma } from './test-prisma.js';

// Stopping the app while a job is running: the job must finish and save before the database pool
// closes, and the pool must close only once. Its own app, because the test closes it. The Stripe call is held open by a promise the
// test resolves itself, so the timing doesn't depend on sleeps.
describe('Shutdown with a running job (e2e)', () => {
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const prisma = createTestPrisma();
  const piId = `pi_test_${run}`;
  const eventId = `evt_test_${run}`;
  let orderId: string;
  let releaseStripe!: () => void;
  const stripeHeld = new Promise<void>((resolve) => (releaseStripe = resolve));
  const retrievePaymentIntent = vi.fn(async () => {
    await stripeHeld;
    return {
      id: piId,
      amount: 4900,
      amount_received: 4900,
      currency: 'usd',
      status: 'succeeded',
      last_payment_error: null,
      metadata: { order_id: orderId },
    };
  });
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, WorkerModule] })
      .overrideProvider(STRIPE_CLIENT)
      .useValue({ paymentIntents: { retrieve: retrievePaymentIntent } })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    releaseStripe();
    await app?.close();
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.stripeEvent.deleteMany({ where: { id: eventId } });
    await prisma.$disconnect();
    // The app's queues are closed with it; clean Redis with new connections.
    const connection = { url: process.env.REDIS_URL };
    const events = new Queue(STRIPE_EVENTS_QUEUE, { connection });
    const reconciliation = new Queue(RECONCILIATION_QUEUE, { connection });
    await events.obliterate({ force: true });
    await reconciliation.removeJobScheduler(RECONCILIATION_SCHEDULER_ID);
    await reconciliation.obliterate({ force: true });
    await events.close();
    await reconciliation.close();
  });

  it('closes the database pool only after a running job has finished and saved', async () => {
    const order = await prisma.order.create({
      data: { courseId: 'nestjs-fundamentals', amount: 4900, currency: 'usd' },
    });
    orderId = order.id;
    await prisma.stripeEvent.create({
      data: {
        id: eventId,
        type: 'payment_intent.payment_failed',
        payload: { id: eventId, data: { object: { id: piId } } },
        stripeCreatedAt: new Date(),
      },
    });
    const queue = app.get<Queue>(getQueueToken(STRIPE_EVENTS_QUEUE));
    await queue.add('stripe-event', { eventId }, { jobId: eventId, attempts: 1 });
    await vi.waitFor(() => expect(retrievePaymentIntent).toHaveBeenCalled(), { timeout: 10_000 });

    // Prisma 7 quietly reopens a closed pool on the next query, so a job still saves after an early
    // disconnect; only the order of the two shows the problem.
    const steps: string[] = [];
    const appPrisma = app.get(PrismaService);
    const disconnect = appPrisma.$disconnect.bind(appPrisma);
    vi.spyOn(appPrisma, '$disconnect').mockImplementation(() => {
      steps.push('pool closed');
      return disconnect();
    });

    // SIGTERM does the same: app.close() runs the shutdown hooks.
    const closing = app.close();
    // Long enough for every hook that doesn't wait for the job to have run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    steps.push('job resumed');
    releaseStripe();
    await closing;

    expect(steps).toEqual(['job resumed', 'pool closed']);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({
      status: 'PROCESSED',
      attempts: 1,
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAID');
  });
});
