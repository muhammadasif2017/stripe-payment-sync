import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { rejectScheduleChanges } from './schedule-guard.js';

const BASE = '/admin/queues/api/queues/reconciliation/job-schedulers/daily-reconciliation';

function call(method: string, originalUrl: string) {
  const req = { method, originalUrl, ip: '127.0.0.1' } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn() as NextFunction;
  rejectScheduleChanges(req, res as unknown as Response, next);
  return { res, next };
}

describe('rejectScheduleChanges', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['Edit schedule', 'PATCH', BASE],
    ['Remove scheduler', 'PUT', `${BASE}/remove`],
    ['Remove scheduler with a query string', 'PUT', `${BASE}/remove?x=1`],
  ])('refuses %s with 403', (_case, method, url) => {
    const { res, next } = call(method, url);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Change RECONCILIATION_CRON instead',
    });
  });

  it.each([
    ['Run now', 'PUT', `${BASE}/run`],
    ['the schedulers list', 'GET', '/admin/queues/api/job-schedulers'],
    ['a job retry', 'PUT', '/admin/queues/api/queues/stripe-events/evt_1/retry'],
    ['a job data update', 'PATCH', '/admin/queues/api/queues/stripe-events/evt_1/update-data'],
  ])('lets %s through', (_case, method, url) => {
    const { res, next } = call(method, url);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
