import { CronExpressionParser } from 'cron-parser';
import Joi from 'joi';
import { isIP } from 'node:net';

/** Settings the app needs, after validation and type conversion. */
export interface Env {
  PORT: number;
  /** Address the HTTP server listens on: 127.0.0.1 (this machine only) unless set. */
  HOST: string;
  /**
   * Express's "trust proxy": false, the number of proxies in front of the app, or the proxies' IPs,
   * subnets or proxy-addr names. Decides which address `req.ip` (and so every rate limit) sees.
   */
  TRUST_PROXY: false | number | string[];
  DATABASE_URL: string;
  REDIS_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Public base URL of this app, used for Stripe's success and cancel redirects. */
  APP_URL: string;
  /** Whether this process runs the background worker for Stripe events. */
  WORKER_ENABLED: boolean;
  /** Login for the queue dashboard at /admin/queues. */
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  /** When the daily reconciliation runs: a 5-field cron pattern, in UTC. */
  RECONCILIATION_CRON: string;
}

// proxy-addr's names for groups of addresses, accepted by Express's "trust proxy".
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Whether `entry` is an IP address, a subnet (`10.0.0.0/8`) or a proxy-addr name. */
function isProxyAddress(entry: string): boolean {
  if (PROXY_NAMES.has(entry)) {
    return true;
  }
  const [address, prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  return /^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

// Custom messages keep secret values out of errors; Joi's default pattern message prints the value.
const envSchema = Joi.object<Env>({
  PORT: Joi.number().port().default(3000),
  // Containers set 0.0.0.0, because a published port reaches the container from outside it.
  HOST: Joi.string().hostname().default('127.0.0.1'),
  // Never `true`: trusting every hop lets any client choose its own req.ip with X-Forwarded-For,
  // and so slip past every per-IP rate limit.
  // Joi returns a default as given, without running custom(), so it is already the parsed value.
  TRUST_PROXY: Joi.string()
    .default(false)
    .custom((value: string, helpers) => {
      const setting = value.trim();
      if (setting === 'false') {
        return false;
      }
      if (/^\d+$/.test(setting)) {
        return Number(setting);
      }
      const entries = setting.split(',').map((entry) => entry.trim());
      if (setting !== 'true' && entries.every(isProxyAddress)) {
        return entries;
      }
      return helpers.error('any.invalid');
    })
    .messages({
      'any.invalid':
        '{#label} must be false, the number of proxies in front of the app, or their IPs or subnets (never true)',
    }),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  STRIPE_SECRET_KEY: Joi.string()
    .pattern(/^sk_test_/)
    .required()
    .messages({ 'string.pattern.base': '{#label} must be a Stripe test-mode key (sk_test_...)' }),
  STRIPE_WEBHOOK_SECRET: Joi.string()
    .pattern(/^whsec_/)
    .required()
    .messages({ 'string.pattern.base': '{#label} must be a Stripe webhook secret (whsec_...)' }),
  // No trailing slash, so paths can be appended as `${APP_URL}/success.html`.
  APP_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/)
    .required()
    .messages({ 'string.pattern.base': '{#label} must not end with a slash' }),
  // Only true or false: a typo like "flase" stops startup instead of silently running a worker.
  WORKER_ENABLED: Joi.boolean().default(true),
  // Basic auth sends "user:password", so a colon in the user name would split it in the wrong place.
  ADMIN_USERNAME: Joi.string()
    .pattern(/^[^:]+$/)
    .default('admin')
    .messages({ 'string.pattern.base': '{#label} must not contain a colon' }),
  // Required with no default: the dashboard can retry and delete jobs, so it never runs with a known password.
  ADMIN_PASSWORD: Joi.string()
    .min(16)
    .required()
    .messages({ 'string.min': '{#label} must be at least {#limit} characters long' }),
  // Parsed with the same library BullMQ uses, so a pattern that passes here also schedules.
  RECONCILIATION_CRON: Joi.string()
    .default('0 3 * * *')
    .custom((value: string, helpers) => {
      if (value.trim().split(/\s+/).length !== 5) {
        return helpers.error('any.invalid');
      }
      try {
        CronExpressionParser.parse(value, { tz: 'UTC' });
      } catch {
        return helpers.error('any.invalid');
      }
      return value;
    })
    .messages({
      'any.invalid':
        '{#label} must be a 5-field cron pattern such as "0 3 * * *" (minute hour day month weekday)',
    }),
});

/**
 * Validates environment variables at startup, for `ConfigModule.forRoot({ validate })`.
 * Throws one error listing every invalid or missing variable, so the app never boots half-configured.
 * @param config Raw variables, usually `process.env` merged with `.env`.
 * @returns The validated settings, with defaults applied and PORT converted to a number.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const { error, value } = envSchema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
  });

  if (error) {
    throw new Error(`Invalid environment configuration: ${error.message}`);
  }

  return value;
}
