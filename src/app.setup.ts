import type { NestApplicationOptions } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { fileURLToPath } from 'node:url';
import type { Env } from './config/env.validation.js';

/**
 * Options for creating the app, shared by `main.ts` and the e2e tests.
 * `rawBody` keeps the request's original bytes in `req.rawBody` next to the parsed JSON: Stripe signs
 * those exact bytes, and re-serialised JSON can differ in spacing or key order.
 */
export const APP_OPTIONS: NestApplicationOptions = { rawBody: true };

/** The checkout pages folder, one level above both `src/` and `dist/`. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Applies the Express settings that live on the app rather than in a Nest module. Called by
 * `main.ts` and by the e2e tests, which build the app without `main.ts`.
 * - "trust proxy" from `TRUST_PROXY`: which address `req.ip` holds, and so what every per-IP rate
 *   limit counts. Unset, it is the connecting socket's address.
 * - The minimal checkout pages in `public/` (`/` is `index.html`). Paths with no matching file fall
 *   through to the API routes, so unknown URLs still get a normal 404.
 * @param app The application, created with the Express adapter.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<Env, true>);
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  app.useStaticAssets(PUBLIC_DIR);
}
