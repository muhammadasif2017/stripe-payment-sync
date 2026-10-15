import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './create-test-app.js';
import { fakeEventPayload, signPayload } from './stripe-webhook.js';

// Needs the PostgreSQL and Redis containers running. Payloads are signed locally; no Stripe CLI needed.
describe('POST /webhooks/stripe (e2e)', () => {
  let app: NestExpressApplication;

  const post = (payload: string, signature?: string) => {
    const req = request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json');
    return (signature ? req.set('Stripe-Signature', signature) : req).send(payload);
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    // Rejections are logged as warnings on purpose; keep the test output clean.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('signature check', () => {
    it('accepts an event signed with the webhook secret', async () => {
      const payload = fakeEventPayload();

      await post(payload, signPayload(payload)).expect(200).expect({ received: true });
    });

    it('rejects a request without a Stripe-Signature header', async () => {
      await post(fakeEventPayload()).expect(400);
    });

    it('rejects a signature made with another secret', async () => {
      const payload = fakeEventPayload();

      await post(payload, signPayload(payload, { secret: 'whsec_someone_else' })).expect(400);
    });

    it('rejects a body changed after signing', async () => {
      const payload = fakeEventPayload();
      const tampered = payload.replace('cs_test_fake', 'cs_test_other');

      await post(tampered, signPayload(payload)).expect(400);
    });

    it('rejects a signature older than 5 minutes (replay)', async () => {
      const payload = fakeEventPayload();
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;

      await post(payload, signPayload(payload, { timestamp: tenMinutesAgo })).expect(400);
    });

    it('rejects a live-mode event even when correctly signed', async () => {
      const payload = fakeEventPayload({ livemode: true });

      await post(payload, signPayload(payload)).expect(400);
    });

    it('does not say why the signature failed', async () => {
      const payload = fakeEventPayload();

      const response = await post(payload, signPayload(payload, { secret: 'whsec_x' })).expect(400);

      expect(response.body.message).toBe('Invalid Stripe signature');
    });
  });
});
