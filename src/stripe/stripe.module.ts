import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation.js';

/** Injection token for the shared Stripe client: `@Inject(STRIPE_CLIENT) private readonly stripe: Stripe`. */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * Stripe API version this code is written against. Written out, not taken from the library, so a
 * library upgrade that changes it fails a unit test instead of silently changing API behaviour.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive';

/**
 * Builds the Stripe client from the validated settings.
 * Retries network errors twice (the library adds an idempotency key, so a retry can't charge twice)
 * and gives up after 20 seconds, so a customer waiting for the checkout page isn't left hanging
 * for the library's default 80 seconds.
 * @param config Validated settings; `STRIPE_SECRET_KEY` is guaranteed to be a test-mode key.
 */
export function createStripeClient(config: ConfigService<Env, true>): Stripe {
  return new Stripe(config.get('STRIPE_SECRET_KEY', { infer: true }), {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
}

/** Provides one Stripe client to the whole app. Tests replace it with `overrideProvider(STRIPE_CLIENT)`. */
@Global()
@Module({
  providers: [{ provide: STRIPE_CLIENT, useFactory: createStripeClient, inject: [ConfigService] }],
  exports: [STRIPE_CLIENT],
})
export class StripeModule {}
