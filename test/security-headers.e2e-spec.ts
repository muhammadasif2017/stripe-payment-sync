import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './create-test-app.js';

// Headers only: whether a browser actually runs the pages under this policy was checked in a real
// browser (docs/BUILD_LOG.md, stage 10 task 3), which supertest can't do.
describe('Security headers (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['the checkout page', '/', false],
    ['the checkout script', '/checkout.js', false],
    ['the API', '/checkout/courses', false],
    ['the dashboard', '/admin/queues', true],
  ])('sets them on %s', async (_label, path, login) => {
    const req = request(app.getHttpServer()).get(path);
    const res = await (login ? req.auth('admin', 'e2e-dashboard-password') : req).expect(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves the checkout page with no inline script, which the policy would block', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);

    expect(res.text).toContain('<script src="/checkout.js"></script>');
    expect(res.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });
});
