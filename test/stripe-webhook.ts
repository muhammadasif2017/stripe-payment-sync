import Stripe from 'stripe';

/** Webhook secret set for the e2e tests in vitest.config.e2e.ts. */
export const TEST_WEBHOOK_SECRET = 'whsec_e2e_test_secret';

// Only used to sign payloads; it never calls the Stripe API.
const stripe = new Stripe('sk_test_signing_only');

/**
 * Builds a minimal Stripe event body, as JSON text, for webhook tests.
 * @param fields Overrides, e.g. `{ type: 'charge.refunded' }` or `{ livemode: true }`.
 */
export function fakeEventPayload(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `evt_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_fake', object: 'checkout.session' } },
    ...fields,
  });
}

/**
 * Signs a payload the way Stripe does, for the `Stripe-Signature` header.
 * @param payload The exact body that will be sent.
 * @param options A different secret or timestamp (seconds) to build invalid signatures.
 */
export function signPayload(
  payload: string,
  options: { secret?: string; timestamp?: number } = {},
): string {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? TEST_WEBHOOK_SECRET,
    timestamp: options.timestamp,
  });
}
