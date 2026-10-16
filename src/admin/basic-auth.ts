import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

/** The user name and password the dashboard accepts. */
export interface BasicAuthCredentials {
  username: string;
  password: string;
}

/** Shown in the browser's login box; also tells it the credentials belong to this area. */
const REALM = 'admin';

const logger = new Logger('BasicAuth');

/**
 * Builds an Express middleware that lets a request through only with the right HTTP Basic credentials.
 * Anything else gets 401 with a `WWW-Authenticate` header, which makes the browser show its login box.
 * @param expected The accepted user name and password.
 */
export function createBasicAuth(
  expected: BasicAuthCredentials,
): (req: Request, res: Response, next: NextFunction) => void {
  const expectedUser = sha256(expected.username);
  const expectedPassword = sha256(expected.password);

  return (req, res, next) => {
    const given = parseBasicAuth(req.headers.authorization);
    // Both checks always run, so the time taken doesn't reveal which of the two was wrong.
    const userOk = given !== undefined && timingSafeEqual(sha256(given.username), expectedUser);
    const passwordOk =
      given !== undefined && timingSafeEqual(sha256(given.password), expectedPassword);
    if (userOk && passwordOk) {
      next();
      return;
    }

    // A missing header is the browser's first request before it asks for a login; only log real attempts.
    if (req.headers.authorization !== undefined) {
      logger.warn(`Rejected dashboard login from ${req.ip} for ${req.method} ${req.originalUrl}`);
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
  };
}

/**
 * Reads `Authorization: Basic base64(user:password)`.
 * @returns The user name and password, or undefined when the header is missing or malformed.
 */
export function parseBasicAuth(header: string | undefined): BasicAuthCredentials | undefined {
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header?.trim() ?? '');
  if (!match) {
    return undefined;
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  // The password may contain colons; only the first one separates it from the user name.
  const colon = decoded.indexOf(':');
  if (colon === -1) {
    return undefined;
  }
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Hashing first gives both sides of `timingSafeEqual` the same length (it throws otherwise), so the
 * comparison takes the same time whatever was typed and leaks nothing about the real value's length.
 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
