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
    },
    // Database test files share one database; run them one at a time so their rows don't collide.
    fileParallelism: false,
  },
});
