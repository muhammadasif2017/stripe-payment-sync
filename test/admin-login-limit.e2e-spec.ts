import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MAX_FAILED_LOGINS } from './../src/admin/login-limit.js';
import { createTestApp } from './create-test-app.js';

// Its own app, so the failed logins counted here don't leak into the other dashboard tests.
describe('Dashboard login rate limit (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    // Rejected logins and the lockout are logged on purpose; keep the output readable.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const dashboard = (password: string) =>
    request(app.getHttpServer()).get('/admin/queues').auth('admin', password);

  it('does not count successful logins', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS + 2; i++) {
      await dashboard('e2e-dashboard-password').expect(200);
    }
  });

  it('locks an IP out after too many failed logins, even with the right password', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await dashboard('wrong-password-123').expect(401);
    }

    const res = await dashboard('e2e-dashboard-password').expect(429);

    expect((res.body as { message: string }).message).toBe(
      'Too many failed logins, try again later',
    );
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('ignores a forged X-Forwarded-For when no proxy is trusted', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      expect([401, 429]).toContain((await dashboard('wrong-password-123')).status);
    }

    await dashboard('e2e-dashboard-password').set('X-Forwarded-For', '203.0.113.9').expect(429);
  });

  it('limits only the dashboard', async () => {
    // Locks the IP out itself, so it means something when run alone. Once an earlier test has
    // locked it out, the rest of these answers are already 429.
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      expect([401, 429]).toContain((await dashboard('wrong-password-123')).status);
    }
    await dashboard('e2e-dashboard-password').expect(429);

    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
