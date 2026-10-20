import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeEventJob } from '../queue/queue.module.js';
import { storedPayload } from './stored-payload.js';
import { WebhooksService } from './webhooks.service.js';

const SECRET = 'whsec_unit_test';

function event(fields: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_unit_1',
    object: 'event',
    created: 1_760_000_000,
    livemode: false,
    type: 'checkout.session.completed',
    data: { object: {} },
    ...fields,
  } as Stripe.Event;
}

function setup() {
  const create = vi.fn().mockResolvedValue({});
  const add = vi.fn().mockResolvedValue({});
  const stripe = new Stripe('sk_test_unit');
  const config = new ConfigService<Env, true>({ STRIPE_WEBHOOK_SECRET: SECRET });
  const service = new WebhooksService(
    stripe,
    config,
    { stripeEvent: { create } } as unknown as PrismaService,
    { add } as unknown as Queue<StripeEventJob>,
  );
  return { service, stripe, create, add };
}

describe('WebhooksService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('verifyEvent', () => {
    it('returns the event for a valid signature', () => {
      const { service, stripe } = setup();
      const payload = JSON.stringify(event());
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

      expect(service.verifyEvent(Buffer.from(payload), header).id).toBe('evt_unit_1');
    });

    it.each([
      ['no body', undefined, 't=1,v1=abc'],
      ['no header', Buffer.from('{}'), undefined],
    ])('rejects a request with %s', (_label, body, header) => {
      const { service } = setup();

      expect(() => service.verifyEvent(body, header)).toThrow(BadRequestException);
    });

    it('rejects a live-mode event', () => {
      const { service, stripe } = setup();
      const payload = JSON.stringify(event({ livemode: true }));
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

      expect(() => service.verifyEvent(Buffer.from(payload), header)).toThrow(
        'Live-mode events are not accepted',
      );
    });
  });

  describe('recordEvent', () => {
    it('stores a handled event and queues it with the event ID as job ID', async () => {
      const { service, create, add } = setup();

      await expect(service.recordEvent(event())).resolves.toBe('stored');

      expect(create).toHaveBeenCalledWith({
        data: {
          id: 'evt_unit_1',
          type: 'checkout.session.completed',
          payload: storedPayload(event()),
          stripeCreatedAt: new Date(1_760_000_000 * 1000),
        },
      });
      expect(add).toHaveBeenCalledWith(
        'stripe-event',
        { eventId: 'evt_unit_1' },
        { jobId: 'evt_unit_1' },
      );
    });

    it('ignores an event type the worker does not handle', async () => {
      const { service, create, add } = setup();

      await expect(service.recordEvent(event({ type: 'product.created' }))).resolves.toBe(
        'ignored',
      );
      expect(create).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    });

    it('treats an already stored event as a duplicate and still queues it', async () => {
      const { service, create, add } = setup();
      create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(service.recordEvent(event())).resolves.toBe('duplicate');
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('lets any other database error through, without queuing', async () => {
      const { service, create, add } = setup();
      create.mockRejectedValue(new Error('connection refused'));

      await expect(service.recordEvent(event())).rejects.toThrow('connection refused');
      expect(add).not.toHaveBeenCalled();
    });

    it('lets a queue error through, so Stripe redelivers the event', async () => {
      const { service, add } = setup();
      add.mockRejectedValue(new Error('Redis is down'));

      await expect(service.recordEvent(event())).rejects.toThrow('Redis is down');
    });
  });
});
