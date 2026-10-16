import { Module, ValidationPipe } from '@nestjs/common';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AdminModule } from './admin/admin.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queue/queue.module.js';
import { StripeModule } from './stripe/stripe.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    StripeModule,
    QueueModule,
    HealthModule,
    CheckoutModule,
    WebhooksModule,
    AdminModule,
    // The worker runs unless WORKER_ENABLED=false: one image can then run as the API, the worker or both.
    ConditionalModule.registerWhen(WorkerModule, 'WORKER_ENABLED'),
  ],
  providers: [
    // Registered here rather than in main.ts so e2e tests, which build the app from this module, get it too.
    // whitelist + forbidNonWhitelisted: a body with unexpected fields (e.g. `amount`) fails with 400.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    },
  ],
})
export class AppModule {}
