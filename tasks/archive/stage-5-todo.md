# Stage 5 â€“ Worker with Retries: Tasks

## Task 1: Mapping functions

**Description:** Pure functions, no database or network: Stripe payment intent status to payment status, Stripe refund status to refund status, and the order status from an order's payments and refunds.

**Acceptance criteria:**
- [x] `toPaymentStatus(paymentIntent)`: `succeeded` â†’ `SUCCEEDED`, `canceled` â†’ `CANCELED`, a failed attempt â†’ `FAILED`, still in progress â†’ no row
- [x] `toRefundStatus(refund)`: `pending`/`requires_action` â†’ `PENDING`, `succeeded`, `failed`, `canceled`
- [x] `deriveOrderStatus(...)`: `PAID`, `PARTIALLY_REFUNDED`, `REFUNDED` from paid vs refunded amounts; `EXPIRED` (sticky once the checkout expired) and `PAYMENT_FAILED` only when nothing was paid; otherwise `PENDING`
- [x] Refunds above the paid amount throw

**Verification:**
- [x] Unit tests for every branch; prove one can fail

**Dependencies:** None

**Files likely touched:** `src/worker/mapping.ts`, `src/worker/mapping.spec.ts`

**Estimated scope:** Small

## Task 2: Event handlers and the transaction

**Description:** For each handled event type, fetch the latest object from Stripe and apply it to the database in one transaction with the order row locked.

**Acceptance criteria:**
- [x] Order found from `metadata.order_id`; missing or unknown order is a permanent error
- [x] Currency or amount different from the order's is a permanent error
- [x] Payments and refunds upserted by Stripe ID; order status recomputed; event marked `PROCESSED` in the same transaction
- [x] Adaptive Pricing turned off in the Checkout Session (decision 1); the stage 3 unit test updated
- [x] Stripe errors classified by type: invalid request is permanent; rate limit, connection and API errors are retried

**Verification:**
- [x] e2e tests against the test database with a fake Stripe client: each event type, the same event twice, events out of order (refund before payment; canceled after expired stays `EXPIRED`), a late `payment_failed` for a payment intent that has since succeeded, a missing order
- [x] Prove a test can fail (e.g. drop the lock or the upsert)

**Dependencies:** Task 1

**Files likely touched:** `src/worker/stripe-event-handler.ts`, `src/checkout/checkout.service.ts`, `test/worker.e2e-spec.ts`

**Estimated scope:** Medium to large

## Checkpoint: Processing logic
- [x] Tasks 1â€“2 verified, all five checks pass, commit

## Task 3: BullMQ processor, retries and error recording

**Description:** The worker that consumes `stripe-events`, records each attempt, and lets BullMQ retry.

**Acceptance criteria:**
- [x] `@Processor(STRIPE_EVENTS_QUEUE)` with concurrency 5, enabled by `WORKER_ENABLED` (default true, validated)
- [x] e2e config sets `WORKER_ENABLED=false` and a dummy `STRIPE_SECRET_KEY`; only the worker e2e file starts the worker, with a fake Stripe client
- [x] Already `PROCESSED` events are skipped
- [x] Each failure saves `attempts` and `last_error`; `FAILED` after the last attempt or a permanent error; other attempts stay `PENDING`
- [x] Failures to save the error are logged, never thrown over the original error

**Verification:**
- [x] e2e with a real BullMQ worker on the test Redis: a job whose first database attempt fails is retried and completes; the event shows the saved error and then `PROCESSED`
- [x] e2e: a permanent error fails at once, without retries
- [x] e2e: a retryable error on every attempt ends with the event `FAILED` and `attempts = 5` (short fixed backoff on the test job)

**Dependencies:** Task 2

**Files likely touched:** `src/worker/stripe-events.processor.ts`, `src/worker/worker.module.ts`, `src/config/env.validation.ts`, `.env.example`, tests

**Estimated scope:** Medium

## Checkpoint: Worker complete
- [x] Tasks 1â€“3 verified, all five checks pass, commit

## Task 4: Database-outage check, docs and pull request

**Description:** Run the "Done when" for real, process the two events waiting since stage 4, document, open the PR.

**Acceptance criteria:**
- [x] With PostgreSQL stopped, a real event's job fails and is retried; after PostgreSQL starts, it completes (event `PROCESSED`, `attempts` > 1, order `PAID`)
- [x] A refund made in the Stripe test dashboard (or with the CLI) arrives and turns the order `PARTIALLY_REFUNDED` or `REFUNDED`
- [x] The stage 4 events: the real one makes its order `PAID`; the `stripe trigger` one is `FAILED` with "no matching order"
- [x] `README.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md` (fetch latest object, computed status, row lock, retryable vs permanent errors)
- [x] PR from `stage-5-worker` to `main`

**Verification:**
- [x] Manual check with Docker, the Stripe CLI and database queries

**Dependencies:** Task 3

**Files likely touched:** `README.md`, `docs/*.md`

**Estimated scope:** Small to medium

## Checkpoint: Stage 5 complete
- [x] All five checks pass
- [x] Stage 5 "Done when" from `PROJECT.md` met
- [x] Commit, push, open PR
- [x] Human review and merge before stage 6
