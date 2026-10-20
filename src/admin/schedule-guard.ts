import { Logger } from '@nestjs/common';
import { Router, type RequestHandler } from 'express';
import { RECONCILIATION_QUEUE } from '../queue/queue.module.js';

const logger = new Logger('ScheduleGuard');

/** Answers 403: the schedule is changed only through `RECONCILIATION_CRON`. */
const refuse: RequestHandler = (req, res) => {
  logger.warn(`Refused dashboard schedule change ${req.method} ${req.originalUrl} from ${req.ip}`);
  res.status(403).json({ statusCode: 403, message: 'Change RECONCILIATION_CRON instead' });
};

/** Refuses only on the reconciliation queue; the same actions on other queues stay allowed. */
const refuseOnReconciliation: RequestHandler = (req, res, next) => {
  if (req.params.queueName === RECONCILIATION_QUEUE) {
    refuse(req, res, next);
    return;
  }
  next();
};

/**
 * Express middleware that refuses schedule changes made on the dashboard. The worker re-registers the
 * reconciliation scheduler from `RECONCILIATION_CRON` at every start, so a change there would be undone
 * silently; the setting is the only place to change it.
 *
 * Refused: Bull Board's "Edit schedule" and "Remove scheduler" on any queue, and emptying or
 * obliterating the reconciliation queue, which deletes its scheduler or the scheduler's next run.
 * "Run now" (`.../run`) stays allowed.
 *
 * It is an Express `Router` with Bull Board's own route paths, not a check on the URL text: it runs
 * just before Bull Board's router on the same request, so both read the path the same way (letter
 * case, a trailing slash, a `#` fragment or a backslash). Unmatched requests pass through.
 */
export const rejectScheduleChanges: RequestHandler = Router()
  .patch('/api/queues/:queueName/job-schedulers/:schedulerId', refuse)
  .put('/api/queues/:queueName/job-schedulers/:schedulerId/remove', refuse)
  .put('/api/queues/:queueName/empty', refuseOnReconciliation)
  .put('/api/queues/:queueName/obliterate', refuseOnReconciliation);
