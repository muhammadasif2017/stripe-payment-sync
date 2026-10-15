import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /checkout`. Only what the customer chooses: the price comes from the catalog.
 * The global ValidationPipe rejects any other field (such as `amount`) with 400.
 */
export class CreateCheckoutDto {
  /** Catalog course ID, e.g. `nestjs-fundamentals`. Whether it exists is checked by the service. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  courseId: string;

  /** Prefills the email field on Stripe's payment page. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
