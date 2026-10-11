import { databaseIdentity, databaseName, resolveTestDatabaseUrl } from './test-database.js';

const devUrl = 'postgresql://payments:secret@localhost:5435/payments';
const testUrl = 'postgresql://payments:secret@localhost:5435/payments_test';

describe('resolveTestDatabaseUrl', () => {
  it('returns the test URL when it points at a separate database', () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: devUrl, TEST_DATABASE_URL: testUrl })).toBe(
      testUrl,
    );
  });

  it('throws when TEST_DATABASE_URL is missing', () => {
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: devUrl })).toThrow('TEST_DATABASE_URL');
  });

  it('throws when both URLs reach the same database, even if spelled differently', () => {
    const sameDb = 'postgresql://other:pw@127.0.0.1:5435/payments?schema=public';

    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL: devUrl, TEST_DATABASE_URL: sameDb }),
    ).toThrow('both point at the database "payments"');
  });

  it('allows the same database name on a different server (when remote is allowed)', () => {
    const otherServer = 'postgresql://payments:secret@ci-db:5432/payments';

    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: devUrl,
        TEST_DATABASE_URL: otherServer,
        ALLOW_REMOTE_TEST_DATABASE: 'true',
      }),
    ).toBe(otherServer);
  });

  it('allows the same database name on a different port of the same machine', () => {
    const otherPort = 'postgresql://payments:secret@localhost:5440/payments';

    expect(resolveTestDatabaseUrl({ DATABASE_URL: devUrl, TEST_DATABASE_URL: otherPort })).toBe(
      otherPort,
    );
  });

  it('refuses a test database that is not on this machine unless explicitly allowed', () => {
    const remote = 'postgresql://payments:secret@shared-staging.example.com:5432/payments_test';

    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL: devUrl, TEST_DATABASE_URL: remote }),
    ).toThrow('ALLOW_REMOTE_TEST_DATABASE');
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: devUrl,
        TEST_DATABASE_URL: remote,
        ALLOW_REMOTE_TEST_DATABASE: 'true',
      }),
    ).toBe(remote);
  });
});

describe('databaseIdentity', () => {
  it('treats localhost, 127.0.0.1 and ::1 as the same host and fills in the default port', () => {
    const a = databaseIdentity('postgresql://u:p@localhost/payments');
    const b = databaseIdentity('postgresql://u:p@127.0.0.1:5432/payments');
    const c = databaseIdentity('postgresql://u:p@[::1]:5432/payments');

    expect(a).toBe('localhost:5432/payments');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe('databaseName', () => {
  it('reads the database name from the URL path', () => {
    expect(databaseName(testUrl)).toBe('payments_test');
  });
});
