import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MAX_FAILED_LOGINS } from './../src/admin/login-limit.js';

// The app as it runs behind one reverse proxy. Settings are read when AppModule is first imported,
// so the variable is set before the dynamic import below; this file runs in its own module scope.
process.env.TRUST_PROXY = '1';

describe('TRUST_PROXY=1 (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const { createTestApp } = await import('./create-test-app.js');
    app = await createTestApp();
  });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const dashboard = (password: string, clientIp: string) =>
    request(app.getHttpServer())
      .get('/admin/queues')
      .auth('admin', password)
      .set('X-Forwarded-For', clientIp);

  it("counts failed logins per client address from the proxy's X-Forwarded-For", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await dashboard('wrong-password-123', '203.0.113.1').expect(401);
    }

    await dashboard('e2e-dashboard-password', '203.0.113.1').expect(429);
    // Another client behind the same proxy isn't locked out by the first one's failures.
    await dashboard('e2e-dashboard-password', '203.0.113.2').expect(200);
  });
});
