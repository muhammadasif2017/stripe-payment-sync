import { databaseName, resolveTestDatabaseUrl } from './test-database.js';

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

  it('throws when both URLs use the same database, even if spelled differently', () => {
    const sameDb = 'postgresql://payments:secret@127.0.0.1:5435/payments?schema=public';

    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL: devUrl, TEST_DATABASE_URL: sameDb }),
    ).toThrow('both use the database "payments"');
  });
});

describe('databaseName', () => {
  it('reads the database name from the URL path', () => {
    expect(databaseName(testUrl)).toBe('payments_test');
  });
});
