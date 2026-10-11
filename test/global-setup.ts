// Runs once before the e2e tests: makes sure the test database exists and has every migration.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { databaseName, resolveTestDatabaseUrl } from './test-database.js';

/** Creates the test database if missing, then applies all Prisma migrations to it. */
export default async function setup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl(process.env);
  const name = databaseName(testUrl);

  // The name goes into a CREATE DATABASE statement, which cannot take a bound parameter.
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Test database name "${name}" may only contain a-z, 0-9 and _.`);
  }

  // Connect to the built-in "postgres" database to create ours; you cannot connect to a database
  // that does not exist yet.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });
}
