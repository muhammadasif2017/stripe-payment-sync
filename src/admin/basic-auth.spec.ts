import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createBasicAuth, parseBasicAuth } from './basic-auth.js';

const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

function call(authorization?: string) {
  const middleware = createBasicAuth({ username: 'admin', password: 'correct horse battery' });
  const req = {
    headers: authorization === undefined ? {} : { authorization },
    ip: '127.0.0.1',
    method: 'GET',
    originalUrl: '/admin/queues',
  } as unknown as Request;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn() as NextFunction;
  middleware(req, res as unknown as Response, next);
  return { res, next };
}

describe('createBasicAuth', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets the right user name and password through', () => {
    const { res, next } = call(basic('admin:correct horse battery'));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong password', basic('admin:wrong password')],
    ['a wrong user name', basic('root:correct horse battery')],
    ['the password alone', basic('correct horse battery')],
    ['a different scheme', 'Bearer abc'],
    ['a malformed header', 'Basic !!!'],
  ])('refuses %s with 401 and a login prompt', (_case, header) => {
    const { res, next } = call(header);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Basic realm="admin", charset="UTF-8"',
    );
  });

  it('asks for a login when there is no header, without logging it as an attempt', () => {
    const { res, next } = call();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a rejected login without the submitted credentials', () => {
    call(basic('admin:my-guess-123'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('my-guess-123');
  });
});

describe('parseBasicAuth', () => {
  it('splits at the first colon, so a password may contain colons', () => {
    expect(parseBasicAuth(basic('admin:a:b:c'))).toEqual({ username: 'admin', password: 'a:b:c' });
  });

  it('accepts the scheme in any case', () => {
    expect(parseBasicAuth(basic('admin:pw').replace('Basic', 'basic'))).toEqual({
      username: 'admin',
      password: 'pw',
    });
  });

  it('returns undefined for a missing header', () => {
    expect(parseBasicAuth(undefined)).toBeUndefined();
  });
});
