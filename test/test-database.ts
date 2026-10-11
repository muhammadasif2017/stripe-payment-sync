/**
 * Returns the URL of the database the e2e tests may write to, after checking it is safe to use.
 * Throws when TEST_DATABASE_URL is missing or points at the development database, because the
 * tests insert and delete rows and must never touch development data.
 * @param env Environment variables, usually `process.env` after loading `.env`.
 */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined>): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Copy it from .env.example into .env.');
  }

  // Compare the database each URL points at, not the raw strings, so different spellings of
  // the same database (e.g. localhost vs 127.0.0.1, a trailing ?schema=) still count as equal.
  const devUrl = env.DATABASE_URL;
  if (devUrl && databaseName(devUrl) === databaseName(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL and DATABASE_URL both use the database "${databaseName(testUrl)}". ` +
        'Point TEST_DATABASE_URL at a separate database, e.g. payments_test.',
    );
  }

  return testUrl;
}

/**
 * Extracts the database name from a PostgreSQL connection URL.
 * @param url A URL such as `postgresql://user:pass@localhost:5435/payments_test`.
 */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}
