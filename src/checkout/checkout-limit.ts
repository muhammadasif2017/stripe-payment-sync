import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

/** Checkouts allowed per IP address in {@link CHECKOUT_WINDOW_MS}. */
export const MAX_CHECKOUTS = 10;

/** The window checkouts are counted in: 1 minute. */
export const CHECKOUT_WINDOW_MS = 60 * 1000;

const logger = new Logger('CheckoutLimit');

/**
 * Builds the rate limit for `POST /checkout`: {@link MAX_CHECKOUTS} requests per IP address within
 * {@link CHECKOUT_WINDOW_MS}, then 429 until the window passes. Each checkout writes an order and
 * calls Stripe, and the worker shares the Stripe account's rate limit, so a flood of checkouts would
 * also make real events fail. Every request counts, including rejected ones. Counts are kept in this
 * process's memory, like the dashboard's login limit.
 */
export function createCheckoutLimiter(): RequestHandler {
  return rateLimit({
    windowMs: CHECKOUT_WINDOW_MS,
    limit: MAX_CHECKOUTS,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Too many checkouts from ${req.ip}; refusing for now`);
      res.status(429).json({ statusCode: 429, message: 'Too many checkouts, try again later' });
    },
  });
}
