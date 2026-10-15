const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Returns the Redis URL the e2e tests may use, after checking it is safe.
 * The tests empty the queues they use, so this throws when:
 * - TEST_REDIS_URL is missing;
 * - it reaches the same Redis database as REDIS_URL (same host, port and database number);
 * - it is not on this machine, unless ALLOW_REMOTE_TEST_DATABASE=true.
 * @param env Environment variables, usually `process.env` after loading `.env`.
 */
export function resolveTestRedisUrl(env: Record<string, string | undefined>): string {
  const testUrl = env.TEST_REDIS_URL;
  if (!testUrl) {
    throw new Error('TEST_REDIS_URL is not set. Copy it from .env.example into .env.');
  }

  const devUrl = env.REDIS_URL;
  if (devUrl && redisIdentity(devUrl) === redisIdentity(testUrl)) {
    throw new Error(
      `TEST_REDIS_URL and REDIS_URL both point at Redis database ${redisDatabase(testUrl)} on the ` +
        'same server. Use another database number for the tests, e.g. redis://localhost:6380/1.',
    );
  }

  const { hostname } = new URL(testUrl);
  if (!LOCAL_HOSTS.has(hostname.toLowerCase()) && env.ALLOW_REMOTE_TEST_DATABASE !== 'true') {
    throw new Error(
      `TEST_REDIS_URL points at "${hostname}", not this machine. The tests delete queue data; ` +
        'set ALLOW_REMOTE_TEST_DATABASE=true only for a throwaway Redis.',
    );
  }

  return testUrl;
}

/**
 * Identifies the Redis database a URL reaches, as `host:port/db`, ignoring credentials.
 * Local host spellings count as one, the port defaults to 6379 and the database to 0.
 * @param url A Redis connection URL.
 */
export function redisIdentity(url: string): string {
  const { hostname, port } = new URL(url);
  const host = LOCAL_HOSTS.has(hostname.toLowerCase()) ? 'localhost' : hostname.toLowerCase();
  return `${host}:${port || '6379'}/${redisDatabase(url)}`;
}

/**
 * Extracts the database number from a Redis URL (`redis://host:6380/1` gives 1; no path gives 0).
 * @param url A Redis connection URL.
 */
export function redisDatabase(url: string): number {
  const path = new URL(url).pathname.replace(/^\//, '');
  return path === '' ? 0 : Number(path);
}
