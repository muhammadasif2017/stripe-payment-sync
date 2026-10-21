import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MAX_CHECKOUTS } from './../src/checkout/checkout-limit.js';
import { STRIPE_CLIENT } from './../src/stripe/stripe.module.js';
import { createTestApp } from './create-test-app.js';

// Its own app, so the checkouts counted here don't leak into checkout.e2e-spec.ts. The bodies are
// invalid on purpose: they count towards the limit but create no order and never reach Stripe.
describe('POST /checkout rate limit (e2e)', () => {
  const createSession = vi.fn();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(STRIPE_CLIENT)
        .useValue({ checkout: { sessions: { create: createSession } } }),
    );
  });

  beforeEach(() => {
    // The refusal is logged on purpose; keep the output readable.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const checkout = () =>
    request(app.getHttpServer()).post('/checkout').send({ courseId: 'free-course' });

  it('refuses an IP after too many checkouts in a minute, and still serves the course list', async () => {
    for (let i = 0; i < MAX_CHECKOUTS; i++) {
      await checkout().expect(400);
    }

    const res = await checkout().expect(429);

    expect((res.body as { message: string }).message).toBe('Too many checkouts, try again later');
    expect(res.headers['ratelimit-policy']).toBeDefined();
    await request(app.getHttpServer()).get('/checkout/courses').expect(200);
    expect(createSession).not.toHaveBeenCalled();
  });
});
