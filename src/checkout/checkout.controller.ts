import { Body, Controller, Get, Post } from '@nestjs/common';
import { Course, listCourses } from './catalog.js';
import { CheckoutResult, CheckoutService } from './checkout.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

/** Starts a test-mode payment for a course. */
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * Lists the courses on sale with their prices, for the checkout page.
   * The page reads them from here so prices exist only in the server's catalog.
   */
  @Get('courses')
  courses(): readonly Course[] {
    return listCourses();
  }

  /**
   * Creates a PENDING order and a Stripe Checkout Session for it.
   * @returns 201 with the order ID and the Stripe payment page URL to redirect the customer to.
   */
  @Post()
  create(@Body() dto: CreateCheckoutDto): Promise<CheckoutResult> {
    return this.checkout.createCheckout(dto);
  }
}
