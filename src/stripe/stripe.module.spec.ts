import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';
import { createStripeClient, STRIPE_API_VERSION } from './stripe.module.js';

describe('createStripeClient', () => {
  const config = new ConfigService<Env, true>({ STRIPE_SECRET_KEY: 'sk_test_123' });

  it('builds a Stripe client with network retries', () => {
    const stripe = createStripeClient(config);

    expect(stripe).toBeInstanceOf(Stripe);
    expect(stripe.getMaxNetworkRetries()).toBe(2);
  });

  it('pins the API version the installed library was built for', () => {
    // Fails after a library upgrade that moves the API version: review Stripe's changelog, then update.
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });
});
