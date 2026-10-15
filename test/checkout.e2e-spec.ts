import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { STRIPE_CLIENT } from './../src/stripe/stripe.module.js';
import { createTestPrisma } from './test-prisma.js';

// Needs the PostgreSQL container running. Stripe is replaced by a fake, so no key or network is needed.
describe('POST /checkout (e2e)', () => {
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = (label: string) => `${label}-${run}@example.com`;
  const createSession = vi.fn();
  const prisma = createTestPrisma();
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STRIPE_CLIENT)
      .useValue({ checkout: { sessions: { create: createSession } } })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    createSession.mockReset();
    createSession.mockImplementation((params: { client_reference_id: string }) =>
      Promise.resolve({
        id: `cs_test_${run}_${params.client_reference_id}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_${run}`,
      }),
    );
  });

  afterAll(async () => {
    // Only this run's rows: every request that can create an order uses an email containing `run`.
    await prisma.order.deleteMany({ where: { customerEmail: { contains: run } } });
    await prisma.$disconnect();
    await app?.close();
  });

  it('saves a PENDING order linked to the Checkout Session and returns the payment page URL', async () => {
    const response = await request(app.getHttpServer())
      .post('/checkout')
      .send({ courseId: 'nestjs-fundamentals', email: email('ok') })
      .expect(201);

    const { orderId, checkoutUrl } = response.body as { orderId: string; checkoutUrl: string };
    expect(checkoutUrl).toBe(`https://checkout.stripe.com/c/pay/cs_test_${run}`);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({
      status: 'PENDING',
      courseId: 'nestjs-fundamentals',
      amount: 4900,
      currency: 'usd',
      customerEmail: email('ok'),
      stripeCheckoutSessionId: `cs_test_${run}_${orderId}`,
    });

    const [params, options] = createSession.mock.calls[0] as [
      { metadata: object; payment_intent_data: { metadata: object } },
      object,
    ];
    expect(params.metadata).toEqual({ order_id: orderId });
    expect(params.payment_intent_data.metadata).toEqual({ order_id: orderId });
    expect(options).toEqual({ idempotencyKey: orderId });
  });

  it.each([
    ['an unknown course', { courseId: 'free-course' }],
    ['a client-chosen amount', { courseId: 'nestjs-fundamentals', amount: 1 }],
    ['a missing courseId', {}],
    ['an invalid email', { courseId: 'nestjs-fundamentals', email: 'not-an-email' }],
  ])('rejects %s with 400 and saves nothing', async (_label, body) => {
    const before = await prisma.order.count();

    await request(app.getHttpServer()).post('/checkout').send(body).expect(400);

    expect(await prisma.order.count()).toBe(before);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns a generic 502 when Stripe fails and keeps the order PENDING without a session', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    createSession.mockRejectedValue(new Error('Invalid API Key provided: sk_test_****1234'));

    const response = await request(app.getHttpServer())
      .post('/checkout')
      .send({ courseId: 'stripe-webhooks', email: email('stripe-down') })
      .expect(502);
    logError.mockRestore();

    expect(JSON.stringify(response.body)).not.toMatch(/API Key|sk_test/);
    const order = await prisma.order.findFirstOrThrow({
      where: { customerEmail: email('stripe-down') },
    });
    expect(order.status).toBe('PENDING');
    expect(order.stripeCheckoutSessionId).toBeNull();
  });
});
