import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { rejectScheduleChanges } from './schedule-guard.js';

// Paths as the guard sees them: Nest mounts the dashboard at /admin/queues, so `url` is relative to it.
const SCHEDULER = '/api/queues/reconciliation/job-schedulers/daily-reconciliation';

/** Runs the guard and resolves once it has answered or passed the request on. */
function call(method: string, url: string) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const req = { method, url, originalUrl: `/admin/queues${url}`, ip: '127.0.0.1', headers: {} };
  return new Promise<{ res: typeof res; passed: boolean }>((resolve) => {
    res.json.mockImplementation(() => {
      resolve({ res, passed: false });
      return res;
    });
    rejectScheduleChanges(req as unknown as Request, res as unknown as Response, () =>
      resolve({ res, passed: true }),
    );
  });
}

describe('rejectScheduleChanges', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['Edit schedule', 'PATCH', SCHEDULER],
    ['Remove scheduler', 'PUT', `${SCHEDULER}/remove`],
    ['Remove scheduler with a query string', 'PUT', `${SCHEDULER}/remove?x=1`],
    // Bull Board's Express router is neither strict nor case-sensitive, and its URL parsing drops a
    // `#` fragment and turns `\` into `/`. The guard is a router too, so it reads them the same way.
    ['Edit schedule with a trailing slash', 'PATCH', `${SCHEDULER}/`],
    ['Remove scheduler with a trailing slash', 'PUT', `${SCHEDULER}/remove/`],
    ['Edit schedule in other letter case', 'PATCH', SCHEDULER.replace('/api/', '/API/')],
    ['Remove scheduler in other letter case', 'PUT', `${SCHEDULER}/REMOVE`],
    ['Remove scheduler with a # fragment', 'PUT', `${SCHEDULER}/remove#`],
    ['Edit schedule with a # fragment', 'PATCH', `${SCHEDULER}/#x`],
    ['Remove scheduler with a backslash', 'PUT', `${SCHEDULER}\\remove#`],
    ['emptying the reconciliation queue', 'PUT', '/api/queues/reconciliation/empty'],
    ['obliterating the reconciliation queue', 'PUT', '/api/queues/reconciliation/obliterate'],
  ])('refuses %s with 403', async (_case, method, url) => {
    const { res, passed } = await call(method, url);

    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Change RECONCILIATION_CRON instead',
    });
  });

  it.each([
    ['Run now', 'PUT', `${SCHEDULER}/run`],
    ['Run now with a trailing slash', 'PUT', `${SCHEDULER}/run/`],
    ['the schedulers list', 'GET', '/api/job-schedulers'],
    ['a job retry', 'PUT', '/api/queues/stripe-events/evt_1/retry'],
    ['a job data update', 'PATCH', '/api/queues/stripe-events/evt_1/update-data'],
    ['emptying another queue', 'PUT', '/api/queues/stripe-events/empty'],
    ['obliterating another queue', 'PUT', '/api/queues/stripe-events/obliterate'],
  ])('lets %s through', async (_case, method, url) => {
    const { res, passed } = await call(method, url);

    expect(passed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});
