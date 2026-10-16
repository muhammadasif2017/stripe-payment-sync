import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolveTestDatabaseUrl } from './test/test-database.js';
import { resolveTestRedisUrl } from './test/test-redis.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Point the app at the test PostgreSQL and Redis databases. Real environment variables win over
    // .env in @nestjs/config, so ConfigModule picks these up instead of the development URLs.
    env: {
      DATABASE_URL: resolveTestDatabaseUrl(process.env),
      REDIS_URL: resolveTestRedisUrl(process.env),
      // Tests sign their own webhook payloads with this secret, so they don't depend on .env or the CLI.
      STRIPE_WEBHOOK_SECRET: 'whsec_e2e_test_secret',
      // No test may reach the real Stripe API or have a worker take the jobs other tests inspect.
      // test/worker.e2e-spec.ts starts its own worker with a fake Stripe client.
      STRIPE_SECRET_KEY: 'sk_test_e2e_dummy_key',
      WORKER_ENABLED: 'false',
    },
    // Database test files share one database; run them one at a time so their rows don't collide.
    fileParallelism: false,
  },
});
