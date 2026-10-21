import type Stripe from 'stripe';
import { storedPayload } from './stored-payload.js';

const event = (object: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
  ({
    id: 'evt_unit_1',
    object: 'event',
    api_version: '2026-09-30.endive',
    created: 1_760_000_000,
    livemode: false,
    type: 'checkout.session.completed',
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: 'key_1' },
    data: { object, previous_attributes: { status: 'open' } },
    ...fields,
  }) as unknown as Stripe.Event;

describe('storedPayload', () => {
  it('keeps the event identity and the IDs the worker reads, and drops customer details', () => {
    const payload = storedPayload(
      event({
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_intent: 'pi_test_1',
        customer_details: { email: 'jane@example.com', name: 'Jane Doe', address: { city: 'X' } },
        customer_email: 'jane@example.com',
        metadata: { order_id: 'o1' },
      }),
    );

    expect(payload).toEqual({
      id: 'evt_unit_1',
      object: 'event',
      api_version: '2026-09-30.endive',
      created: 1_760_000_000,
      livemode: false,
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_test_1', object: 'checkout.session', payment_intent: 'pi_test_1' },
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/jane|Jane/);
  });

  it('stores an expanded payment_intent as its ID', () => {
    const payload = storedPayload(
      event({
        id: 'ch_test_1',
        object: 'charge',
        payment_intent: { id: 'pi_test_2', object: 'payment_intent', receipt_email: 'a@b.c' },
      }),
    );

    expect(payload.data).toEqual({
      object: { id: 'ch_test_1', object: 'charge', payment_intent: 'pi_test_2' },
    });
  });

  it('keeps a null payment_intent and leaves out fields Stripe did not send', () => {
    expect(
      storedPayload(event({ id: 'cs_test_3', object: 'checkout.session', payment_intent: null }))
        .data,
    ).toEqual({ object: { id: 'cs_test_3', object: 'checkout.session', payment_intent: null } });
    expect(storedPayload(event({ id: 'pi_test_4', object: 'payment_intent' })).data).toEqual({
      object: { id: 'pi_test_4', object: 'payment_intent' },
    });
  });
});
