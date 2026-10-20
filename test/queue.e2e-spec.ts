import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import {
  RECONCILIATION_QUEUE,
  STRIPE_EVENTS_QUEUE,
  type StripeEventJob,
} from './../src/queue/queue.module.js';
import { createTestApp } from './create-test-app.js';

// Needs the Redis container running. Uses the test Redis database (TEST_REDIS_URL) and empties it.
describe('stripe-events queue (e2e)', () => {
  let app: NestExpressApplication;
  let queue: Queue<StripeEventJob>;

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get<Queue<StripeEventJob>>(getQueueToken(STRIPE_EVENTS_QUEUE));
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  // Checked by value, not against the constants that set them: a changed number must fail a test.
  it('gives every job 5 attempts with exponential backoff from 10 s, keeping failed jobs', async () => {
    const job = await queue.add('stripe-event', { eventId: `evt_test_${Date.now()}_opts` });

    expect(job.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: false,
    });
  });

  it('gives reconciliation runs 3 attempts with exponential backoff from 1 minute', async () => {
    const reconciliation = app.get<Queue>(getQueueToken(RECONCILIATION_QUEUE));
    try {
      const job = await reconciliation.add('reconcile', {});

      expect(job.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 60 * 60 },
        removeOnFail: false,
      });
    } finally {
      await reconciliation.obliterate({ force: true });
    }
  });

  it('keeps one job when the same event ID is added twice', async () => {
    const eventId = `evt_test_${Date.now()}`;

    await queue.add('stripe-event', { eventId }, { jobId: eventId });
    await queue.add('stripe-event', { eventId }, { jobId: eventId });

    const counts = await queue.getJobCounts();
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(1);
    expect((await queue.getJob(eventId))?.data).toEqual({ eventId });
  });
});
