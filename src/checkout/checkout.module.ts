import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { createCheckoutLimiter } from './checkout-limit.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

/** `POST /checkout`: orders and Stripe Checkout Sessions. */
@Module({
  controllers: [CheckoutController],
  providers: [CheckoutService],
})
export class CheckoutModule implements NestModule {
  /**
   * Rate-limits `POST /checkout` only; the page's `GET /checkout/courses` is read on every visit.
   * Applied here rather than in main.ts so e2e tests, which build the app from AppModule, get it too.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createCheckoutLimiter())
      .forRoutes({ path: 'checkout', method: RequestMethod.POST });
  }
}
