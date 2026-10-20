-- Stage 10: stripe_events.payload keeps only what the code reads (src/webhooks/stored-payload.ts).
-- New events are trimmed when stored; this trims the events already stored the same way, so the
-- customer details they hold (email, name, address) are removed too. It can't be undone.
-- jsonb_strip_nulls drops keys Stripe didn't send. It also drops a JSON null `payment_intent`,
-- which the worker reads the same as an absent one.
UPDATE "stripe_events"
SET "payload" = jsonb_strip_nulls(jsonb_build_object(
  'id', "payload"->'id',
  'object', "payload"->'object',
  'api_version', "payload"->'api_version',
  'created', "payload"->'created',
  'livemode', "payload"->'livemode',
  'type', "payload"->'type',
  'data', jsonb_build_object('object', jsonb_build_object(
    'id', "payload"->'data'->'object'->'id',
    'object', "payload"->'data'->'object'->'object',
    -- An expanded payment intent is kept as its ID, like a new event.
    'payment_intent', CASE jsonb_typeof("payload"->'data'->'object'->'payment_intent')
      WHEN 'object' THEN "payload"->'data'->'object'->'payment_intent'->'id'
      ELSE "payload"->'data'->'object'->'payment_intent'
    END
  ))
));
