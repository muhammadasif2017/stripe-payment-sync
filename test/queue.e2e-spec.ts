import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import {
  STRIPE_EVENT_JOB_OPTIONS,
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

  it('uses the retry and retention settings for every job', () => {
    expect(queue.defaultJobOptions).toMatchObject(STRIPE_EVENT_JOB_OPTIONS);
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
