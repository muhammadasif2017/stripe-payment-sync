import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

/** Failed dashboard logins allowed per IP address in {@link LOGIN_WINDOW_MS}. */
export const MAX_FAILED_LOGINS = 10;

/** The window failed logins are counted in: 15 minutes. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const logger = new Logger('LoginLimit');

/**
 * Builds the dashboard's login rate limit: after {@link MAX_FAILED_LOGINS} failed logins (401) from
 * one IP address within {@link LOGIN_WINDOW_MS}, every dashboard request from it gets 429 until the
 * window passes, even with the right password. Successful requests don't count, so an admin using
 * the dashboard is never limited. Counts are kept in this process's memory: enough for one API
 * process; several API processes would need a shared store (e.g. Redis).
 *
 * Behind a reverse proxy, `req.ip` is the proxy's address unless Express's "trust proxy" is set.
 */
export function createLoginLimiter(): RequestHandler {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: MAX_FAILED_LOGINS,
    // Only failed logins count: a 403 or 404 from a logged-in admin is not a password guess.
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Too many failed dashboard logins from ${req.ip}; refusing for now`);
      res.status(429).json({ statusCode: 429, message: 'Too many failed logins, try again later' });
    },
  });
}
