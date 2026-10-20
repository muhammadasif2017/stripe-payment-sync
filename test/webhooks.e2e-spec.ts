import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { STRIPE_EVENTS_QUEUE, type StripeEventJob } from './../src/queue/queue.module.js';
import { createTestApp } from './create-test-app.js';
import { fakeEventPayload, signPayload } from './stripe-webhook.js';
import { createTestPrisma } from './test-prisma.js';

// Needs the PostgreSQL and Redis containers running. Payloads are signed locally; no Stripe CLI needed.
describe('POST /webhooks/stripe (e2e)', () => {
  let app: NestExpressApplication;
  let queue: Queue<StripeEventJob>;
  const prisma = createTestPrisma();
  // IDs of every event this file sends, so cleanup removes only its own rows.
  const eventIds: string[] = [];

  /** A new event body, remembered for cleanup. */
  const newEvent = (fields: Record<string, unknown> = {}): string => {
    const payload = fakeEventPayload(fields);
    eventIds.push((JSON.parse(payload) as { id: string }).id);
    return payload;
  };
  const idOf = (payload: string) => (JSON.parse(payload) as { id: string }).id;
  const savedRows = (id: string) => prisma.stripeEvent.count({ where: { id } });

  const post = (payload: string, signature?: string) => {
    const req = request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json');
    return (signature ? req.set('Stripe-Signature', signature) : req).send(payload);
  };

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get<Queue<StripeEventJob>>(getQueueToken(STRIPE_EVENTS_QUEUE));
    await queue.obliterate({ force: true });
  });

  beforeEach(() => {
    // Rejections are logged as warnings on purpose; keep the test output clean.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  describe('signature check', () => {
    it('accepts an event signed with the webhook secret', async () => {
      const payload = newEvent();

      await post(payload, signPayload(payload)).expect(200).expect({ received: true });
    });

    it('rejects a request without a Stripe-Signature header', async () => {
      await post(newEvent()).expect(400);
    });

    it('rejects a signature made with another secret', async () => {
      const payload = newEvent();

      await post(payload, signPayload(payload, { secret: 'whsec_someone_else' })).expect(400);
    });

    it('rejects a body changed after signing', async () => {
      const payload = newEvent();
      const tampered = payload.replace('cs_test_fake', 'cs_test_other');

      await post(tampered, signPayload(payload)).expect(400);
    });

    it('rejects a signature older than 5 minutes (replay)', async () => {
      const payload = newEvent();
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;

      await post(payload, signPayload(payload, { timestamp: tenMinutesAgo })).expect(400);
    });

    it('rejects a live-mode event even when correctly signed', async () => {
      const payload = newEvent({ livemode: true });

      await post(payload, signPayload(payload)).expect(400);
    });

    it('does not say why the signature failed', async () => {
      const payload = newEvent();

      const response = await post(payload, signPayload(payload, { secret: 'whsec_x' })).expect(400);

      expect(response.body.message).toBe('Invalid Stripe signature');
    });
  });

  describe('storing and queuing', () => {
    it("stores only the IDs the worker reads, never the customer's details", async () => {
      const payload = newEvent({
        data: {
          object: {
            id: 'cs_test_with_customer',
            object: 'checkout.session',
            payment_intent: 'pi_test_with_customer',
            customer_details: { email: 'jane@example.com', name: 'Jane Doe' },
            customer_email: 'jane@example.com',
          },
        },
      });
      const id = idOf(payload);

      await post(payload, signPayload(payload)).expect(200);

      const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect((row.payload as { data: unknown }).data).toEqual({
        object: {
          id: 'cs_test_with_customer',
          object: 'checkout.session',
          payment_intent: 'pi_test_with_customer',
        },
      });
      expect(JSON.stringify(row.payload)).not.toContain('jane');
    });

    it('stores a handled event as PENDING and queues one job with the event ID', async () => {
      const payload = newEvent();
      const id = idOf(payload);

      await post(payload, signPayload(payload)).expect(200);

      const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        type: 'checkout.session.completed',
        status: 'PENDING',
        attempts: 0,
      });
      // fakeEventPayload's object holds only the fields that are kept.
      expect(row.payload).toEqual(JSON.parse(payload));
      const { created } = JSON.parse(payload) as { created: number };
      expect(row.stripeCreatedAt.getTime()).toBe(created * 1000);
      expect((await queue.getJob(id))?.data).toEqual({ eventId: id });
    });

    it('keeps 1 row and 1 job when Stripe delivers the same event twice', async () => {
      const payload = newEvent();
      const id = idOf(payload);
      const countBefore = await queue.count();

      await post(payload, signPayload(payload)).expect(200);
      await post(payload, signPayload(payload)).expect(200);

      expect(await savedRows(id)).toBe(1);
      expect(await queue.count()).toBe(countBefore + 1);
    });

    it('answers 200 to an unhandled event type without saving or queuing it', async () => {
      const payload = newEvent({ type: 'product.created' });

      await post(payload, signPayload(payload)).expect(200);

      expect(await savedRows(idOf(payload))).toBe(0);
      expect(await queue.getJob(idOf(payload))).toBeUndefined();
    });

    it('saves and queues nothing for a wrong signature', async () => {
      const payload = newEvent();

      await post(payload, signPayload(payload, { secret: 'whsec_wrong' })).expect(400);

      expect(await savedRows(idOf(payload))).toBe(0);
      expect(await queue.getJob(idOf(payload))).toBeUndefined();
    });

    it('answers 500 when queuing fails, and the redelivery completes the job', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const payload = newEvent();
      const id = idOf(payload);
      vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Redis is down'));

      await post(payload, signPayload(payload)).expect(500);
      expect(await savedRows(id)).toBe(1);
      expect(await queue.getJob(id)).toBeUndefined();

      // Stripe retries the same event later.
      await post(payload, signPayload(payload)).expect(200);
      expect(await savedRows(id)).toBe(1);
      expect((await queue.getJob(id))?.data).toEqual({ eventId: id });
    });
  });
});
