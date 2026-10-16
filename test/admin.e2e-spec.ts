import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import request from 'supertest';
import {
  RECONCILIATION_QUEUE,
  STRIPE_EVENTS_QUEUE,
  type StripeEventJob,
} from './../src/queue/queue.module.js';
import { createTestApp } from './create-test-app.js';

// The queue dashboard at /admin/queues: mounted, behind Basic auth on every path, and able to retry.
describe('Queue dashboard (e2e)', () => {
  const USER = 'admin';
  const PASSWORD = 'e2e-dashboard-password'; // set in vitest.config.e2e.ts
  let app: NestExpressApplication;
  let queue: Queue<StripeEventJob>;

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get<Queue<StripeEventJob>>(getQueueToken(STRIPE_EVENTS_QUEUE));
    await queue.obliterate({ force: true });
  });

  beforeEach(() => {
    // Rejected logins are logged on purpose; keep the output readable.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('serves the dashboard page with the right login (proves it is mounted)', async () => {
    const res = await get('/admin/queues').auth(USER, PASSWORD).expect(200);

    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<div id="root">');
  });

  it('lists both queues through its API', async () => {
    const res = await get('/admin/queues/api/queues').auth(USER, PASSWORD).expect(200);

    // stripe-events (stage 6) and reconciliation (stage 7), so a run can be started from here.
    expect((res.body as { queues: { name: string }[] }).queues.map((q) => q.name).sort()).toEqual(
      [RECONCILIATION_QUEUE, STRIPE_EVENTS_QUEUE].sort(),
    );
  });

  it.each([
    '/admin/queues',
    '/admin/queues/',
    '/admin/queues/queue/stripe-events',
    '/admin/queues/api/queues',
    '/admin/queues/static/favicon.ico',
  ])('asks for a login on %s', async (path) => {
    const res = await get(path).expect(401);

    expect(res.headers['www-authenticate']).toBe('Basic realm="admin", charset="UTF-8"');
  });

  it('refuses a wrong password, also for actions', async () => {
    await get('/admin/queues').auth(USER, 'wrong-password-123').expect(401);
    await request(app.getHttpServer())
      .put(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/pause`)
      .auth(USER, 'wrong-password-123')
      .expect(401);
  });

  it('serves its static files after login', async () => {
    await get('/admin/queues/static/favicon.ico').auth(USER, PASSWORD).expect(200);
  });

  it('retries a failed job: the job moves back to waiting', async () => {
    const jobId = `evt_admin_${Date.now()}`;
    // A throwaway worker that fails the job at once, standing in for a real failure.
    const worker = new Worker<StripeEventJob>(
      STRIPE_EVENTS_QUEUE,
      () => Promise.reject(new UnrecoverableError('forced failure')),
      { connection: { url: process.env.REDIS_URL } },
    );
    const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
    await queue.add('stripe-event', { eventId: jobId }, { jobId });
    await failed;
    await worker.close();
    expect(await queue.getJobState(jobId)).toBe('failed');

    await request(app.getHttpServer())
      .put(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/${jobId}/retry`)
      .auth(USER, PASSWORD)
      .expect(204);

    expect(await queue.getJobState(jobId)).toBe('waiting');
  });

  it('does not approve cross-origin requests (no CORS), so other sites cannot send dashboard actions', async () => {
    const res = await request(app.getHttpServer())
      .options(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/pause`)
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PUT');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a form POST from another site, even with the cached login: no job is added', async () => {
    const before = await queue.count();

    // What a browser sends when a page on another site submits a form to the dashboard. A form
    // needs no CORS preflight, and the browser attaches the Basic credentials it remembers.
    await request(app.getHttpServer())
      .post(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/add`)
      .auth(USER, PASSWORD)
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Content-Type', 'text/plain')
      .send('{"name":"stripe-event","data":{"eventId":"evt_forged"}}')
      .expect(403);

    expect(await queue.count()).toBe(before);
  });

  it('lets the dashboard page itself send actions (same origin)', async () => {
    await request(app.getHttpServer())
      .put(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/pause`)
      .auth(USER, PASSWORD)
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
    await request(app.getHttpServer())
      .put(`/admin/queues/api/queues/${STRIPE_EVENTS_QUEUE}/resume`)
      .auth(USER, PASSWORD)
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
  });

  it('leaves the rest of the app public', async () => {
    await get('/health').expect(200);
  });
});
