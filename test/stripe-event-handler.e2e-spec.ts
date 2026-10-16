import type Stripe from 'stripe';
import type { Prisma } from './../src/generated/prisma/client.js';
import type { PrismaService } from './../src/prisma/prisma.service.js';
import { PermanentProcessingError } from './../src/worker/mapping.js';
import { StripeEventHandler } from './../src/worker/stripe-event-handler.js';
import { createTestPrisma } from './test-prisma.js';

// Runs the handler against the test database with a fake Stripe client.
describe('StripeEventHandler (e2e)', () => {
  const prisma = createTestPrisma();
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orderIds: string[] = [];
  const eventIds: string[] = [];

  // What the fake Stripe API returns, set per test.
  const stripeState: {
    sessions: Record<string, Partial<Stripe.Checkout.Session>>;
    paymentIntents: Record<string, Partial<Stripe.PaymentIntent>>;
    refunds: Record<string, Partial<Stripe.Refund>[]>;
    error?: Error;
  } = { sessions: {}, paymentIntents: {}, refunds: {} };

  const fail = () => {
    if (stripeState.error) throw stripeState.error;
  };
  const fakeStripe = {
    checkout: {
      sessions: {
        retrieve: (id: string) => {
          fail();
          const session = stripeState.sessions[id];
          const pi = session?.payment_intent;
          return Promise.resolve({
            ...session,
            payment_intent: typeof pi === 'string' ? stripeState.paymentIntents[pi] : pi,
          });
        },
      },
    },
    paymentIntents: {
      retrieve: (id: string) => {
        fail();
        return Promise.resolve(stripeState.paymentIntents[id]);
      },
    },
    refunds: {
      list: ({ payment_intent }: { payment_intent: string }) => ({
        autoPagingToArray: () => {
          fail();
          return Promise.resolve(stripeState.refunds[payment_intent] ?? []);
        },
      }),
    },
  };
  const handler = new StripeEventHandler(
    prisma as unknown as PrismaService,
    fakeStripe as unknown as Stripe,
  );

  let n = 0;
  const uid = (prefix: string) => `${prefix}_${run}_${++n}`;

  async function newOrder(amount = 4900) {
    const order = await prisma.order.create({
      data: { courseId: 'nestjs-fundamentals', amount, currency: 'usd' },
    });
    orderIds.push(order.id);
    return order;
  }

  function paymentIntent(orderId: string, fields: Partial<Stripe.PaymentIntent> = {}) {
    const pi = {
      id: uid('pi_test'),
      amount: 4900,
      amount_received: 4900,
      currency: 'usd',
      status: 'succeeded',
      last_payment_error: null,
      metadata: { order_id: orderId },
      ...fields,
    } as Partial<Stripe.PaymentIntent>;
    stripeState.paymentIntents[pi.id!] = pi;
    return pi;
  }

  function session(
    orderId: string,
    piId: string | null,
    fields: Partial<Stripe.Checkout.Session> = {},
  ) {
    const s = {
      id: uid('cs_test'),
      status: 'complete',
      currency: 'usd',
      amount_total: 4900,
      metadata: { order_id: orderId },
      client_reference_id: orderId,
      payment_intent: piId,
      ...fields,
    } as Partial<Stripe.Checkout.Session>;
    stripeState.sessions[s.id!] = s;
    return s;
  }

  /** Stores an event row like the webhook does and returns what the worker would load. */
  async function storedEvent(type: string, object: Record<string, unknown>) {
    const id = uid('evt_test');
    eventIds.push(id);
    const payload = { id, type, data: { object } } as Prisma.InputJsonObject;
    await prisma.stripeEvent.create({
      data: { id, type, payload, stripeCreatedAt: new Date() },
    });
    return { id, type, payload: payload as Prisma.JsonValue };
  }

  const orderWithRows = (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      include: { payments: { include: { refunds: true } } },
    });

  beforeEach(() => {
    stripeState.error = undefined;
  });

  afterAll(async () => {
    await prisma.refund.deleteMany({ where: { payment: { orderId: { in: orderIds } } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
  });

  it('checkout.session.completed: records the payment, marks the order PAID and the event PROCESSED', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id);
    const s = session(order.id, pi.id!);
    const event = await storedEvent('checkout.session.completed', { id: s.id });

    await handler.handle(event, 1);

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PAID');
    expect(saved.stripeCheckoutSessionId).toBe(s.id);
    expect(saved.payments).toMatchObject([
      { stripePaymentIntentId: pi.id, amount: 4900, currency: 'usd', status: 'SUCCEEDED' },
    ]);
    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row).toMatchObject({ status: 'PROCESSED', attempts: 1, lastError: null });
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it('gives the same result when the same event is processed twice', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id);
    const event = await storedEvent('checkout.session.completed', {
      id: session(order.id, pi.id!).id,
    });

    await handler.handle(event, 1);
    await handler.handle(event, 2);

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PAID');
    expect(saved.payments).toHaveLength(1);
  });

  it('a late payment_failed for a payment intent that has since succeeded records the success', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id); // now succeeded, after a first declined card
    const event = await storedEvent('payment_intent.payment_failed', { id: pi.id });

    await handler.handle(event, 1);

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PAID');
    expect(saved.payments[0].status).toBe('SUCCEEDED');
  });

  it('payment_intent.payment_failed: records the declined payment and marks the order PAYMENT_FAILED', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id, {
      status: 'requires_payment_method',
      amount_received: 0,
      last_payment_error: { code: 'card_declined' } as Stripe.PaymentIntent.LastPaymentError,
    });

    await handler.handle(await storedEvent('payment_intent.payment_failed', { id: pi.id }), 1);

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PAYMENT_FAILED');
    expect(saved.payments[0]).toMatchObject({ status: 'FAILED', amount: 4900 });
  });

  it('keeps an expired order EXPIRED when its payment intent is canceled afterwards', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id, { status: 'canceled', amount_received: 0 });
    const s = session(order.id, null, { status: 'expired' });

    await handler.handle(await storedEvent('checkout.session.expired', { id: s.id }), 1);
    expect((await orderWithRows(order.id)).status).toBe('EXPIRED');

    await handler.handle(await storedEvent('payment_intent.canceled', { id: pi.id }), 1);

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('EXPIRED');
    expect(saved.payments[0].status).toBe('CANCELED');
  });

  it('handles a refund that arrives before the payment event, then the payment event', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id);
    stripeState.refunds[pi.id!] = [
      {
        id: uid('re_test'),
        amount: 1000,
        currency: 'usd',
        status: 'succeeded',
        payment_intent: pi.id,
      },
    ];

    await handler.handle(
      await storedEvent('charge.refunded', { id: uid('ch_test'), payment_intent: pi.id }),
      1,
    );
    let saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PARTIALLY_REFUNDED');
    expect(saved.payments[0].refunds).toMatchObject([{ amount: 1000, status: 'SUCCEEDED' }]);

    const s = session(order.id, pi.id!);
    await handler.handle(await storedEvent('checkout.session.completed', { id: s.id }), 1);
    saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PARTIALLY_REFUNDED');
    expect(saved.payments).toHaveLength(1);
  });

  it('refund.updated: a full refund marks the order REFUNDED, counting every refund', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id);
    const refunds = [
      {
        id: uid('re_test'),
        amount: 1900,
        currency: 'usd',
        status: 'succeeded',
        payment_intent: pi.id,
      },
      {
        id: uid('re_test'),
        amount: 3000,
        currency: 'usd',
        status: 'succeeded',
        payment_intent: pi.id,
      },
    ];
    stripeState.refunds[pi.id!] = refunds;

    await handler.handle(
      await storedEvent('refund.updated', { id: refunds[1].id, payment_intent: pi.id }),
      1,
    );

    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('REFUNDED');
    expect(saved.payments[0].refunds).toHaveLength(2);
  });

  it('fails permanently when the order in the metadata does not exist, and saves nothing', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const pi = paymentIntent(missing);

    const event = await storedEvent('payment_intent.canceled', { id: pi.id });

    await expect(handler.handle(event, 1)).rejects.toThrow(PermanentProcessingError);
    expect((await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'PENDING',
    );
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: pi.id } })).toBe(0);
  });

  it('fails permanently for an event without our order_id (e.g. from stripe trigger)', async () => {
    const pi = paymentIntent('ignored', { metadata: {} });

    await expect(
      handler.handle(await storedEvent('payment_intent.canceled', { id: pi.id }), 1),
    ).rejects.toThrow('no valid order_id');
  });

  it('fails permanently when Stripe charged a different currency than the order', async () => {
    const order = await newOrder();
    const pi = paymentIntent(order.id, {
      currency: 'pkr',
      amount: 1_400_000,
      amount_received: 1_400_000,
    });
    const s = session(order.id, pi.id!, { currency: 'pkr', amount_total: 1_400_000 });

    await expect(
      handler.handle(await storedEvent('checkout.session.completed', { id: s.id }), 1),
    ).rejects.toThrow(PermanentProcessingError);
    const saved = await orderWithRows(order.id);
    expect(saved.status).toBe('PENDING');
    expect(saved.payments).toHaveLength(0);
  });

  it('fails permanently when Stripe says the object does not exist', async () => {
    stripeState.error = Object.assign(new Error('No such payment_intent'), {
      type: 'StripeInvalidRequestError',
    });

    await expect(
      handler.handle(await storedEvent('payment_intent.canceled', { id: 'pi_gone' }), 1),
    ).rejects.toThrow(PermanentProcessingError);
  });

  it('lets a Stripe rate limit through as a retryable error', async () => {
    stripeState.error = Object.assign(new Error('Too many requests'), {
      type: 'StripeRateLimitError',
    });

    const failure = handler.handle(await storedEvent('payment_intent.canceled', { id: 'pi_x' }), 1);

    await expect(failure).rejects.toThrow('Too many requests');
    await expect(failure).rejects.not.toThrow(PermanentProcessingError);
  });
});
