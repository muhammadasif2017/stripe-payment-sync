import { validateEnv } from './env.validation.js';

const validEnv = {
  DATABASE_URL: 'postgresql://payments:secret@localhost:5435/payments',
  REDIS_URL: 'redis://localhost:6380',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  APP_URL: 'http://localhost:3000',
};

describe('validateEnv', () => {
  it('accepts a complete config and defaults PORT to 3000', () => {
    const env = validateEnv(validEnv);

    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it('converts PORT from a string to a number', () => {
    expect(validateEnv({ ...validEnv, PORT: '4000' }).PORT).toBe(4000);
  });

  it.each(Object.keys(validEnv))('rejects a config missing %s and names it', (key) => {
    const env: Record<string, unknown> = { ...validEnv };
    delete env[key];

    expect(() => validateEnv(env)).toThrow(key);
  });

  it('lists every missing variable in one error, not only the first', () => {
    expect(() => validateEnv({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*STRIPE_SECRET_KEY[\s\S]*STRIPE_WEBHOOK_SECRET[\s\S]*APP_URL/,
    );
  });

  it('rejects a live Stripe key', () => {
    expect(() => validateEnv({ ...validEnv, STRIPE_SECRET_KEY: 'sk_live_123' })).toThrow(
      'STRIPE_SECRET_KEY',
    );
  });

  it('rejects a webhook secret without the whsec_ prefix', () => {
    expect(() => validateEnv({ ...validEnv, STRIPE_WEBHOOK_SECRET: 'abc' })).toThrow(
      'STRIPE_WEBHOOK_SECRET',
    );
  });

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    expect(() => validateEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      'DATABASE_URL',
    );
  });

  it.each(['ftp://localhost:3000', 'localhost:3000', 'http://localhost:3000/'])(
    'rejects APP_URL %s',
    (url) => {
      expect(() => validateEnv({ ...validEnv, APP_URL: url })).toThrow('APP_URL');
    },
  );

  it('runs the worker by default and reads WORKER_ENABLED=false as off', () => {
    expect(validateEnv(validEnv).WORKER_ENABLED).toBe(true);
    expect(validateEnv({ ...validEnv, WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(false);
  });

  it('rejects a WORKER_ENABLED that is not true or false', () => {
    expect(() => validateEnv({ ...validEnv, WORKER_ENABLED: 'flase' })).toThrow('WORKER_ENABLED');
  });

  it('does not put secret values in the error message', () => {
    const run = () => validateEnv({ ...validEnv, STRIPE_SECRET_KEY: 'sk_live_supersecret' });

    // Assert the throw first: a try/catch with expect.unreachable() inside would swallow its own failure.
    expect(run).toThrow('STRIPE_SECRET_KEY');
    expect(run).not.toThrow('supersecret');
  });
});
