import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { APP_OPTIONS, configureApp } from '../src/app.setup.js';

/**
 * Builds and starts the app the way `main.ts` does (same options, same Express settings), for e2e tests.
 * @param customize Optional changes to the module before it compiles, e.g. replacing the Stripe client
 *   with `builder.overrideProvider(STRIPE_CLIENT).useValue(fake)`.
 */
export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<NestExpressApplication> {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  configureApp(app);
  await app.init();
  return app;
}
