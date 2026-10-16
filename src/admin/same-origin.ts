import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Methods that only read; Bull Board changes jobs only through POST, PUT, PATCH and DELETE. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const logger = new Logger('SameOrigin');

/**
 * Express middleware that refuses state-changing requests a browser marks as coming from another site.
 *
 * Why: the browser re-sends Basic auth credentials automatically, so a page on another site could
 * submit a form to the dashboard (a cross-site request forgery). Forms can only send "simple" requests,
 * which need no CORS preflight, and Bull Board has POST routes (such as "add job") that accept them.
 * Browsers label every request with `Sec-Fetch-Site` and send `Origin` on POST, and a page can't
 * forge either, so checking them stops the attack. Requests with neither header (curl, scripts) don't
 * come from a browser and can't be forged this way, so they pass.
 */
export function rejectCrossSite(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || isSameOrigin(req)) {
    next();
    return;
  }
  logger.warn(`Refused cross-site ${req.method} ${req.originalUrl} from ${req.ip}`);
  res.status(403).json({ statusCode: 403, message: 'Forbidden' });
}

function isSameOrigin(req: Request): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  // "none" means the user typed the URL or used a bookmark, not another page.
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    // Includes `Origin: null`, which browsers send from sandboxed or file pages.
    return false;
  }
}
