import type { NestExpressApplication } from '@nestjs/platform-express';
import { fileURLToPath } from 'node:url';

/** The checkout pages folder, one level above both `src/` and `dist/`. */
export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Serves the minimal checkout pages in `public/` (`/` is `index.html`). Paths with no matching file
 * fall through to the API routes, so unknown URLs still get a normal 404.
 * Called by `main.ts` and by the e2e tests, which build the app without `main.ts`.
 * @param app The application, created with the Express adapter.
 */
export function serveCheckoutPages(app: NestExpressApplication): void {
  app.useStaticAssets(PUBLIC_DIR);
}
