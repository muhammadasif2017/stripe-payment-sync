import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolveTestDatabaseUrl } from './test/test-database.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Point the app at the test database. Real environment variables win over .env in
    // @nestjs/config, so ConfigModule picks this up instead of the development DATABASE_URL.
    env: { DATABASE_URL: resolveTestDatabaseUrl(process.env) },
    // Database test files share one database; run them one at a time so their rows don't collide.
    fileParallelism: false,
  },
});
