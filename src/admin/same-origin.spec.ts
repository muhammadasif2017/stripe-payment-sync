import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { rejectCrossSite } from './same-origin.js';

function call(method: string, headers: Record<string, string>) {
  const req = {
    method,
    headers: { host: 'localhost:3000', ...headers },
    ip: '127.0.0.1',
    originalUrl: '/admin/queues/api/queues/stripe-events/add',
  } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn() as NextFunction;
  rejectCrossSite(req, res as unknown as Response, next);
  return { res, next };
}

describe('rejectCrossSite', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'a GET from anywhere',
      'GET',
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    ],
    ['a POST from the dashboard page', 'POST', { 'sec-fetch-site': 'same-origin' }],
    ['a POST with a matching Origin', 'POST', { origin: 'http://localhost:3000' }],
    ['a PUT typed into the address bar', 'PUT', { 'sec-fetch-site': 'none' }],
    ['a POST from curl (no browser headers)', 'POST', {}],
  ])('lets through %s', (_case, method, headers) => {
    const { res, next } = call(method, headers);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['a POST marked cross-site', 'POST', { 'sec-fetch-site': 'cross-site' }],
    ['a POST from a sibling subdomain', 'POST', { 'sec-fetch-site': 'same-site' }],
    ['a POST with another Origin', 'POST', { origin: 'https://evil.example' }],
    ['a PUT with Origin null (sandboxed page)', 'PUT', { origin: 'null' }],
    ['a DELETE with a port that differs', 'DELETE', { origin: 'http://localhost:4000' }],
  ])('refuses %s with 403', (_case, method, headers) => {
    const { res, next } = call(method, headers);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
