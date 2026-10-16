# Implementation Plan: Stage 5 – Worker with Retries

## Overview

Stage 5 processes the queued Stripe events (see `PROJECT.md`, stage 5). A BullMQ worker takes each job, fetches the latest version of the object from Stripe, updates the order, payment or refund in one database transaction, and marks the event processed. A failed attempt saves the error on the event and is retried: 5 attempts with exponential backoff (already set on the queue in stage 4).

**Done when (from `PROJECT.md`):** you stop PostgreSQL while a job runs, start it again, and the job completes on a retry.

Stage 1–4 plans and tasks are archived in `tasks/archive/`.

## Flow

```
job { eventId } ──> load stripe_events row ──> already PROCESSED? done (idempotent)
                        │
                        v
                    fetch latest object from Stripe (outside the transaction)
                        │  session / payment intent / refunds
                        v
                    BEGIN
                      lock the order row (SELECT ... FOR UPDATE)
                      upsert payment / refunds by their Stripe IDs
                      recompute the order status from its payments and refunds
                      event: PROCESSED, attempts + 1, processed_at
                    COMMIT
   on error ──> event: attempts + 1, last_error; FAILED after the last attempt
                rethrow, so BullMQ retries (10 s, 20 s, 40 s, 80 s)
                permanent errors (no matching order, wrong currency) fail at once
```

## What each event does

| Event | Fetches | Writes |
| --- | --- | --- |
| `checkout.session.completed` | session with its payment intent | payment from the payment intent; order status recomputed |
| `checkout.session.expired` | session | order marked expired; status recomputed |
| `payment_intent.payment_failed` | payment intent | payment from the payment intent; status recomputed |
| `payment_intent.canceled` | payment intent | payment from the payment intent; status recomputed |
| `charge.refunded`, `refund.updated` | payment intent and all its refunds (every page) | payment and refunds upserted; status recomputed |

The event type only says what to fetch. What is written always comes from the fetched object: a `payment_intent.payment_failed` job that runs after the customer retried and paid finds the payment intent `succeeded` and records a successful payment. The order is found from `metadata.order_id` (set in stage 3 on both the session and the payment intent).

## Architecture Decisions

- **Fetch the latest object instead of trusting the event body.** Stripe doesn't guarantee delivery order, and a retried job may run minutes later. The current object from the API is the truth; the event only says what to look at. This also makes processing the same event twice harmless.
- **The order status is computed, not stepped.** A pure function derives it from the order's payments, refunds and whether its checkout expired (refunded total vs paid amount; `EXPIRED` sticks unless money was paid, so a `payment_intent.canceled` arriving after `checkout.session.expired` can't turn the order back to `PENDING`). Events arriving in any order converge to the same result, and the function is easy to unit-test. These mapping functions are the "unit tests for the mapping functions" in `PROJECT.md`.
- **One transaction per event, with the order row locked.** Payment, refunds, order status and the event's `PROCESSED` mark commit together or not at all. `SELECT ... FOR UPDATE` on the order stops two jobs for the same order (say, `checkout.session.completed` and `charge.refunded`) from computing the status from stale rows at the same time. Stripe calls happen before the transaction, so no lock is held during network calls.
- **Idempotent at three levels:** the event is skipped when already `PROCESSED`; payments and refunds are upserted on their unique Stripe IDs; the order status is recomputed from scratch.
- **Retryable vs permanent errors.** A database outage, a network error, a Stripe rate limit (429) or a Stripe server error is retried. A missing order, a currency or amount that doesn't match the order, or a Stripe invalid-request error (such as an object that doesn't exist) can't succeed on a retry, so it fails at once (BullMQ `UnrecoverableError`) and the event is marked `FAILED` with the reason, for the dashboard in stage 6.
- **Errors are saved on each failure** (`attempts`, `last_error`), as the brief requires. If the database itself is down, saving the error fails too; that is logged and BullMQ still retries.
- **Refunds can never add up to more than the payment.** Checked in the transaction (promised in stage 2); a mismatch is a permanent error.
- **Worker runs inside the app for now, behind a `WORKER_ENABLED` setting** (default `true`). Stage 8's Docker Compose can then start the same image twice: API with the worker off, worker with it on. Concurrency 5. The e2e tests turn it off (and use a dummy Stripe key), so no test can reach the real Stripe API; only the worker's own e2e file starts it, with a fake Stripe client.

## Decisions for you

1. **Turn off Adaptive Pricing in Checkout? (recommended: yes)** Stage 4 showed Stripe offering the buyer PKR. Multiple currencies are out of scope, so the session gets `adaptive_pricing: { enabled: false }` and always charges the catalog price in USD. The worker still checks currency and amount against the order and fails the event if they differ.
2. **`WORKER_ENABLED` switch now? (recommended: yes)** It costs one setting and lets the manual "Done when" run the worker as its own process, the way stage 8 will.

## The "Done when" check

1. Run the API with `WORKER_ENABLED=false` and `stripe listen`; make a test payment. The event is stored and its job waits.
2. Stop PostgreSQL (`docker compose stop postgres`).
3. Start a worker process (`WORKER_ENABLED=true`, another port). The job fails, the error is logged, BullMQ schedules a retry.
4. Start PostgreSQL. The next retry completes: payment `SUCCEEDED`, order `PAID`, event `PROCESSED` with `attempts` > 1.

Checked before planning: the app starts while PostgreSQL is stopped (`/health` answers 503), so step 3 works as written.

## Risks

- **Two events from stage 4 are waiting in the dev queue.** The one from `stripe trigger` has no `order_id`, so it will fail permanently with "no matching order". That is correct behaviour and a useful dashboard example in stage 6.
- **Stripe API shapes in version `2026-09-30.endive`** (for example how refunds are listed) are taken from the installed types, not from memory. Refunds are listed with the library's auto-pagination, not just the first page.
- **The stage 3 unit test asserts the exact Checkout Session parameters,** so adding `adaptive_pricing` changes it on purpose.
- **What BullMQ 6 puts in `attemptsMade` while a job runs** decides when the last attempt is detected; read from the installed types and covered by a test.

## Task List

Tasks are tracked in `tasks/todo.md`.
