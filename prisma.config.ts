// Config for the Prisma CLI (migrate, generate, studio). The running app does not read this file;
// it gets DATABASE_URL from ConfigService instead.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // process.env, not Prisma's env() helper: env() throws when the variable is unset, which would
    // break `prisma generate` on a fresh install (CI, Docker build) where no database is needed.
    url: process.env.DATABASE_URL,
  },
});
