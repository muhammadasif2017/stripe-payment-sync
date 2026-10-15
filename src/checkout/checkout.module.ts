import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

/** `POST /checkout`: orders and Stripe Checkout Sessions. */
@Module({
  controllers: [CheckoutController],
  providers: [CheckoutService],
})
export class CheckoutModule {}
