const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Returns the URL of the database the e2e tests may write to, after checking it is safe to use.
 * The tests insert and delete rows, so this throws when:
 * - TEST_DATABASE_URL is missing;
 * - it reaches the same database as DATABASE_URL (same host, port and database name);
 * - it is not on this machine, unless ALLOW_REMOTE_TEST_DATABASE=true (e.g. a CI database
 *   service), so a typo can't point the tests at a shared server.
 * @param env Environment variables, usually `process.env` after loading `.env`.
 */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined>): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Copy it from .env.example into .env.');
  }

  const devUrl = env.DATABASE_URL;
  if (devUrl && databaseIdentity(devUrl) === databaseIdentity(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL and DATABASE_URL both point at the database "${databaseName(testUrl)}" ` +
        'on the same server. Point TEST_DATABASE_URL at a separate database, e.g. payments_test.',
    );
  }

  if (!isLocalHost(new URL(testUrl).hostname) && env.ALLOW_REMOTE_TEST_DATABASE !== 'true') {
    throw new Error(
      `TEST_DATABASE_URL points at "${new URL(testUrl).hostname}", not this machine. The tests ` +
        'delete rows; set ALLOW_REMOTE_TEST_DATABASE=true only for a throwaway database.',
    );
  }

  return testUrl;
}

/**
 * Identifies the database a URL reaches, as `host:port/name`, ignoring credentials and options.
 * Local host spellings (localhost, 127.0.0.1, ::1) count as one, and the port defaults to 5432.
 * @param url A PostgreSQL connection URL.
 */
export function databaseIdentity(url: string): string {
  const { hostname, port } = new URL(url);
  const host = isLocalHost(hostname) ? 'localhost' : hostname.toLowerCase();
  return `${host}:${port || '5432'}/${databaseName(url)}`;
}

/**
 * Extracts the database name from a PostgreSQL connection URL.
 * @param url A URL such as `postgresql://user:pass@localhost:5435/payments_test`.
 */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}
