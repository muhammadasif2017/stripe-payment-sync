import { redisDatabase, redisIdentity, resolveTestRedisUrl } from './test-redis.js';

describe('resolveTestRedisUrl', () => {
  const REDIS_URL = 'redis://localhost:6380';

  it('accepts a different database number on the same server', () => {
    const url = 'redis://localhost:6380/1';
    expect(resolveTestRedisUrl({ REDIS_URL, TEST_REDIS_URL: url })).toBe(url);
  });

  it('refuses a missing TEST_REDIS_URL', () => {
    expect(() => resolveTestRedisUrl({ REDIS_URL })).toThrow('TEST_REDIS_URL is not set');
  });

  it.each(['redis://localhost:6380', 'redis://127.0.0.1:6380/0', 'redis://user:pw@localhost:6380/'])(
    'refuses %s, the same database as REDIS_URL',
    (url) => {
      expect(() => resolveTestRedisUrl({ REDIS_URL, TEST_REDIS_URL: url })).toThrow('same server');
    },
  );

  it('refuses a remote Redis unless explicitly allowed', () => {
    const url = 'redis://cache.example.com:6379/1';
    expect(() => resolveTestRedisUrl({ REDIS_URL, TEST_REDIS_URL: url })).toThrow('not this machine');
    expect(
      resolveTestRedisUrl({ REDIS_URL, TEST_REDIS_URL: url, ALLOW_REMOTE_TEST_DATABASE: 'true' }),
    ).toBe(url);
  });
});

describe('redisIdentity', () => {
  it('defaults the port to 6379 and the database to 0', () => {
    expect(redisIdentity('redis://localhost')).toBe('localhost:6379/0');
    expect(redisDatabase('redis://localhost:6380/3')).toBe(3);
  });
});
