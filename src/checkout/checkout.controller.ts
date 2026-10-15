import { Body, Controller, Post } from '@nestjs/common';
import { CheckoutResult, CheckoutService } from './checkout.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

/** Starts a test-mode payment for a course. */
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * Creates a PENDING order and a Stripe Checkout Session for it.
   * @returns 201 with the order ID and the Stripe payment page URL to redirect the customer to.
   */
  @Post()
  create(@Body() dto: CreateCheckoutDto): Promise<CheckoutResult> {
    return this.checkout.createCheckout(dto);
  }
}
