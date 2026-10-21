import type { NestApplicationOptions } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
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
 * helmet's defaults (a Content-Security-Policy, `nosniff`, a strict referrer policy, no
 * `X-Powered-By`, and others) with two changes:
 * - `frame-ancestors 'none'`: no site may show these pages in a frame, so the dashboard's buttons
 *   can't be clickjacked. The default allows the same site.
 * - No `upgrade-insecure-requests`: the app is served over plain HTTP on localhost, where that
 *   directive would ask browsers to load its own scripts over HTTPS. A deployment gets HTTPS from
 *   the proxy in front of it.
 * The default CSP fits both pages: scripts only from this site (the checkout script is a file for
 * that reason), and inline styles and the Google Fonts stylesheet that Bull Board's page uses.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: { 'frame-ancestors': ["'none'"], 'upgrade-insecure-requests': null },
    },
  });
}

/**
 * Applies the Express settings that live on the app rather than in a Nest module. Called by
 * `main.ts` and by the e2e tests, which build the app without `main.ts`.
 * - "trust proxy" from `TRUST_PROXY`: which address `req.ip` holds, and so what every per-IP rate
 *   limit counts. Unset, it is the connecting socket's address.
 * - Security headers from helmet on every response, including the dashboard: see {@link securityHeaders}.
 * - The minimal checkout pages in `public/` (`/` is `index.html`). Paths with no matching file fall
 *   through to the API routes, so unknown URLs still get a normal 404.
 * @param app The application, created with the Express adapter.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<Env, true>);
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  app.use(securityHeaders());
  app.useStaticAssets(PUBLIC_DIR);
}
