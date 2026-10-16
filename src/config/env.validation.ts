import { CronExpressionParser } from 'cron-parser';
import Joi from 'joi';

/** Settings the app needs, after validation and type conversion. */
export interface Env {
  PORT: number;
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

// Custom messages keep secret values out of errors; Joi's default pattern message prints the value.
const envSchema = Joi.object<Env>({
  PORT: Joi.number().port().default(3000),
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
