import type Stripe from 'stripe';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * The part of a Stripe event worth keeping in `stripe_events.payload`: what identifies the event, and
 * the IDs the worker and the repair SQL read (`data.object.id`, `data.object.payment_intent`). The
 * worker fetches everything else from Stripe, so the rest of the object, which can hold the
 * customer's email, name and address, is never stored.
 * An expanded `payment_intent` is kept as its ID, the form the repair SQL compares. Fields Stripe
 * didn't send stay absent rather than becoming `null`.
 * @param event A verified event.
 */
export function storedPayload(event: Stripe.Event): Prisma.InputJsonObject {
  const object = event.data.object as unknown as Record<string, unknown>;
  const paymentIntent = object.payment_intent;
  const paymentIntentId =
    paymentIntent && typeof paymentIntent === 'object'
      ? (paymentIntent as { id?: unknown }).id
      : paymentIntent;
  return withoutUndefined({
    id: event.id,
    object: event.object,
    api_version: event.api_version,
    created: event.created,
    livemode: event.livemode,
    type: event.type,
    data: {
      object: withoutUndefined({
        id: object.id,
        object: object.object,
        payment_intent: paymentIntentId,
      }),
    },
  });
}

// A JSON object can't hold `undefined`; drop those keys instead of storing them as null.
function withoutUndefined(fields: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Prisma.InputJsonObject;
}
