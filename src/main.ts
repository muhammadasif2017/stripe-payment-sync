import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { APP_OPTIONS, configureApp } from './app.setup.js';
import type { Env } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, APP_OPTIONS);
  configureApp(app);
  // Runs onModuleDestroy hooks (e.g. closing the database pool) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('PORT', { infer: true }), config.get('HOST', { infer: true }));
}
await bootstrap();
