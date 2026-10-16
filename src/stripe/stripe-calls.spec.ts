import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeCalls } from './stripe-calls.js';

describe('StripeCalls', () => {
  let calls: StripeCalls;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls = new StripeCalls();
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the result and logs endpoint, event, status, duration and request ID', async () => {
    const result = { id: 'pi_1', lastResponse: { statusCode: 200, requestId: 'req_ok' } };

    await expect(
      calls.run('paymentIntents.retrieve', { eventId: 'evt_1' }, () => Promise.resolve(result)),
    ).resolves.toBe(result);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(
      /^paymentIntents\.retrieve event=evt_1 status=200 duration=\d+ms request=req_ok$/,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the order or job when there is no event', async () => {
    await calls.run('checkout.sessions.create', { orderId: 'ord_1' }, () => Promise.resolve({}));
    await calls.run('checkout.sessions.list', { job: 'reconciliation' }, () => Promise.resolve({}));

    expect(log.mock.calls[0][0]).toContain('checkout.sessions.create order=ord_1 ');
    expect(log.mock.calls[1][0]).toContain('checkout.sessions.list job=reconciliation ');
  });

  it('logs status=ok for a result without lastResponse (test fakes)', async () => {
    await calls.run('refunds.list', { eventId: 'evt_1' }, () => Promise.resolve({ data: [] }));

    expect(log.mock.calls[0][0]).toMatch(/status=ok duration=\d+ms$/);
  });

  it('rethrows the same error and logs its status, type and request ID', async () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      message: 'Invalid API Key provided',
      statusCode: 401,
      requestId: 'req_401',
    });

    const thrown = await calls
      .run('paymentIntents.retrieve', { eventId: 'evt_1' }, () => Promise.reject(error))
      .catch((e: unknown) => e);

    expect(thrown).toBe(error);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /^paymentIntents\.retrieve event=evt_1 status=401 \(StripeAuthenticationError\) duration=\d+ms request=req_401$/,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('logs "no response" when the call failed before Stripe answered', async () => {
    const error = new Stripe.errors.StripeConnectionError({
      message: 'An error occurred with our connection to Stripe. Request was retried 2 times.',
    });

    await expect(
      calls.run('refunds.list', { eventId: 'evt_1' }, () => Promise.reject(error)),
    ).rejects.toBe(error);

    expect(warn.mock.calls[0][0]).toMatch(
      /^refunds\.list event=evt_1 status=no response \(StripeConnectionError\) duration=\d+ms$/,
    );
  });

  it('logs a non-Stripe error by its name', async () => {
    await expect(
      calls.run('refunds.list', { eventId: 'evt_1' }, () => Promise.reject(new TypeError('boom'))),
    ).rejects.toThrow('boom');

    expect(warn.mock.calls[0][0]).toContain('status=no response (TypeError)');
  });

  it('measures how long the call took', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1213.4);

    await calls.run('paymentIntents.retrieve', { eventId: 'evt_1' }, () => Promise.resolve({}));

    expect(log.mock.calls[0][0]).toContain('duration=213ms');
  });

  it('never logs the parameters of the call', async () => {
    const stripe = {
      create: (params: { customer_email: string }) =>
        Promise.resolve({ id: 'cs_1', customer_email: params.customer_email }),
    };

    await calls.run('checkout.sessions.create', { orderId: 'ord_1' }, () =>
      stripe.create({ customer_email: 'buyer@example.com' }),
    );
    await calls
      .run('checkout.sessions.create', { orderId: 'ord_1' }, () =>
        Promise.reject(new Error('Bad email buyer@example.com')),
      )
      .catch(() => undefined);

    const output = [...log.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(output).not.toContain('buyer@example.com');
  });
});
