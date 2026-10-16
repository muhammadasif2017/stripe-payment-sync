import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CheckoutService } from './checkout.service.js';

const ORDER_ID = '0b7c6b1e-4a5f-4c8e-9a51-3f2d8e1c7a90';

function setup() {
  const prisma = {
    order: {
      create: vi.fn().mockResolvedValue({ id: ORDER_ID }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const createSession = vi.fn().mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  });
  const stripe = { checkout: { sessions: { create: createSession } } };
  const config = new ConfigService<Env, true>({ APP_URL: 'http://localhost:3000' });
  const service = new CheckoutService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
    config,
  );
  return { service, prisma, createSession };
}

describe('CheckoutService', () => {
  beforeEach(() => {
    // The service logs Stripe failures on purpose; keep the test output clean.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a PENDING order with the catalog price, not a client price', async () => {
    const { service, prisma } = setup();

    await service.createCheckout({ courseId: 'nestjs-fundamentals', email: 'a@example.com' });

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: {
        courseId: 'nestjs-fundamentals',
        amount: 4900,
        currency: 'usd',
        customerEmail: 'a@example.com',
      },
    });
  });

  it('creates the Checkout Session with the order ID in metadata and as idempotency key', async () => {
    const { service, createSession } = setup();

    await service.createCheckout({ courseId: 'nestjs-fundamentals', email: 'a@example.com' });

    expect(createSession).toHaveBeenCalledWith(
      {
        mode: 'payment',
        allowed_payment_method_types: ['card'],
        adaptive_pricing: { enabled: false },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: 4900,
              product_data: { name: 'NestJS Fundamentals' },
            },
          },
        ],
        client_reference_id: ORDER_ID,
        customer_email: 'a@example.com',
        metadata: { order_id: ORDER_ID },
        payment_intent_data: { metadata: { order_id: ORDER_ID } },
        success_url: 'http://localhost:3000/success.html?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'http://localhost:3000/cancel.html',
      },
      { idempotencyKey: ORDER_ID },
    );
  });

  it('links the session to the order and returns the payment page URL', async () => {
    const { service, prisma } = setup();

    const result = await service.createCheckout({ courseId: 'nestjs-fundamentals' });

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      data: { stripeCheckoutSessionId: 'cs_test_123' },
    });
    expect(result).toEqual({
      orderId: ORDER_ID,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
  });

  it('rejects an unknown course before saving anything', async () => {
    const { service, prisma, createSession } = setup();

    await expect(service.createCheckout({ courseId: 'free-course' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns a generic 502 when Stripe fails and leaves the order without a session', async () => {
    const { service, prisma, createSession } = setup();
    createSession.mockRejectedValue(
      Object.assign(new Error('Invalid API Key provided: sk_test_****1234'), {
        type: 'StripeAuthenticationError',
      }),
    );

    const failure = service.createCheckout({ courseId: 'nestjs-fundamentals' });

    await expect(failure).rejects.toThrow(BadGatewayException);
    await expect(failure).rejects.not.toThrow(/API Key/);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('StripeAuthenticationError'),
      expect.any(String),
    );
  });

  it('returns 502 when Stripe answers without a payment page URL', async () => {
    const { service, prisma, createSession } = setup();
    createSession.mockResolvedValue({ id: 'cs_test_123', url: null });

    await expect(service.createCheckout({ courseId: 'nestjs-fundamentals' })).rejects.toThrow(
      BadGatewayException,
    );
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});
