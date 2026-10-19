import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Bull Board's routes that change or delete a job scheduler ("Edit schedule", "Remove scheduler").
 * "Run now" (`.../run`) is not matched and stays allowed. Bull Board's Express router is neither
 * strict nor case-sensitive, so a trailing slash and any letter case reach the same routes; the
 * patterns allow both.
 */
const SCHEDULE_CHANGES: { method: string; path: RegExp }[] = [
  { method: 'PATCH', path: /\/api\/queues\/[^/]+\/job-schedulers\/[^/]+\/?$/i },
  { method: 'PUT', path: /\/api\/queues\/[^/]+\/job-schedulers\/[^/]+\/remove\/?$/i },
];

const logger = new Logger('ScheduleGuard');

/**
 * Express middleware that refuses schedule changes made on the dashboard. The worker re-registers the
 * reconciliation scheduler from `RECONCILIATION_CRON` at every start, so an edit there would be undone
 * silently; the setting is the only place to change it.
 */
export function rejectScheduleChanges(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split('?')[0];
  if (!SCHEDULE_CHANGES.some((route) => route.method === req.method && route.path.test(path))) {
    next();
    return;
  }
  logger.warn(`Refused dashboard schedule change ${req.method} ${path} from ${req.ip}`);
  res.status(403).json({ statusCode: 403, message: 'Change RECONCILIATION_CRON instead' });
}
