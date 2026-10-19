import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { APP_OPTIONS } from './../src/app.setup.js';
import { RECONCILIATION_QUEUE, RECONCILIATION_SCHEDULER_ID } from './../src/queue/queue.module.js';
import { STRIPE_CLIENT } from './../src/stripe/stripe.module.js';
import { WorkerModule } from './../src/worker/worker.module.js';

// The daily schedule and the dashboard's "Run now", with a real worker on the test Redis and a fake
// Stripe client that lists no sessions. WORKER_ENABLED is false for the e2e suite, so this file adds
// the worker module itself.
describe('Reconciliation schedule (e2e)', () => {
  let app: NestExpressApplication;
  let queue: Queue;
  const listSessions = vi.fn(() => Promise.resolve({ data: [], has_more: false }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, WorkerModule] })
      .overrideProvider(STRIPE_CLIENT)
      .useValue({ checkout: { sessions: { list: listSessions } } })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    await app.init();
    queue = app.get<Queue>(getQueueToken(RECONCILIATION_QUEUE));
  });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await queue?.removeJobScheduler(RECONCILIATION_SCHEDULER_ID);
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  it('registers the daily scheduler at 03:00 UTC when the worker starts', async () => {
    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toEqual([
      expect.objectContaining({
        key: RECONCILIATION_SCHEDULER_ID,
        pattern: '0 3 * * *',
        tz: 'UTC',
      }),
    ]);
  });

  it('runs at once from the dashboard ("Run now") and returns the summary', async () => {
    const res = await request(app.getHttpServer())
      .put(
        `/admin/queues/api/queues/${RECONCILIATION_QUEUE}/job-schedulers/${RECONCILIATION_SCHEDULER_ID}/run`,
      )
      .auth('admin', 'e2e-dashboard-password')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
    const jobId = (res.body as { job: { id: string } }).job.id;

    let state = '';
    for (let i = 0; i < 100 && state !== 'completed' && state !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await queue.getJobState(jobId);
    }

    expect(state).toBe('completed');
    expect((await queue.getJob(jobId))!.returnvalue).toMatchObject({ checked: 0, missing: 0 });
    expect(listSessions).toHaveBeenCalledTimes(1);
    // "Run now" leaves the schedule as it was.
    expect(await queue.getJobSchedulersCount()).toBe(1);
  });

  const schedulerRoute = `/admin/queues/api/queues/${RECONCILIATION_QUEUE}/job-schedulers/${RECONCILIATION_SCHEDULER_ID}`;

  it('refuses "Edit schedule" and "Remove scheduler"; the schedule is unchanged', async () => {
    const server = app.getHttpServer();
    const edit = await request(server)
      .patch(schedulerRoute)
      .auth('admin', 'e2e-dashboard-password')
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ pattern: '* * * * *' })
      .expect(403);
    await request(server)
      .put(`${schedulerRoute}/remove`)
      .auth('admin', 'e2e-dashboard-password')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(403);

    expect((edit.body as { message: string }).message).toBe('Change RECONCILIATION_CRON instead');
    expect(await queue.getJobSchedulers()).toEqual([
      expect.objectContaining({ key: RECONCILIATION_SCHEDULER_ID, pattern: '0 3 * * *' }),
    ]);
  });

  it('also refuses them with a trailing slash or in other letter case', async () => {
    const server = app.getHttpServer();
    const upper = schedulerRoute.replace('/api/', '/API/');
    for (const path of [`${schedulerRoute}/`, upper]) {
      await request(server)
        .patch(path)
        .auth('admin', 'e2e-dashboard-password')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ pattern: '* * * * *' })
        .expect(403);
    }
    for (const path of [`${schedulerRoute}/remove/`, `${upper}/REMOVE`]) {
      await request(server)
        .put(path)
        .auth('admin', 'e2e-dashboard-password')
        .set('Sec-Fetch-Site', 'same-origin')
        .expect(403);
    }

    expect(await queue.getJobSchedulers()).toEqual([
      expect.objectContaining({ key: RECONCILIATION_SCHEDULER_ID, pattern: '0 3 * * *' }),
    ]);
  });
});
