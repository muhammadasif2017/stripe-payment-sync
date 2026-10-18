# Implementation Plan: Stage 7 – Daily Reconciliation

## Overview

Stage 7 is the safety net behind the webhook (see `PROJECT.md`, stage 7). Once a day, a scheduled job lists the Checkout Sessions Stripe completed in the last 2 days, finds the paid ones whose payment is missing from the database, and queues a repair for each. The repair fetches the session from Stripe and writes the payment, its refunds and the order status, through the same code the worker uses for events.

**Done when (from `PROJECT.md`):** you delete a payment row, run the job, and the row comes back.

Stage 1–6 plans and tasks are archived in `tasks/archive/`.

## Flow

```
every day 03:00 UTC (BullMQ job scheduler, queue "reconciliation")
  or "Run now" on the dashboard
        │
        v
list Checkout Sessions: status=complete, created in the last 2 days (every page, each page logged)
        │
        v
keep sessions with payment_status=paid and a valid order_id that exists in the database
        │
        v
one query: which of their payment intents have a SUCCEEDED payment row?
        │
        v
for each one without: queue job "reconcile-session" { sessionId } on "stripe-events"
        │                                    (job ID unique per run)
        v
log one summary line: checked, skipped, missing, queued

worker, "reconcile-session" job:
  fetch session (with its payment intent) and the payment intent's refunds
  BEGIN; lock order; upsert payment and refunds; recompute order status; COMMIT
  (no stripe_events row involved; retries and dashboard work as for events)
```

## Why not re-queue the original Stripe event

It looks simpler, but it can't work. A completed job stays in Redis for 7 days, and adding a job whose ID already exists is silently ignored. Even if the job ran, the processor skips events already marked `PROCESSED`. And the original event may be missing altogether: that is one of the cases reconciliation exists for. So repairs are their own job type, keyed by the Checkout Session, with nothing depending on `stripe_events`.

## What counts as missing

A session is repaired when Stripe says it is `complete` and `paid`, and the database has **no `SUCCEEDED` payment** for its payment intent. One rule covers:

- a deleted payment row (the "Done when"),
- a webhook that never arrived, or an event that never got processed,
- stage 5's known limit: the database was down on the 5th attempt, so the event stayed `PENDING` with no payment,
- a stale row (`FAILED` in the database, `succeeded` at Stripe).

Skipped and counted, not queued: sessions without a valid `order_id` (such as the stage 4 `stripe trigger` session, which is still inside the 2-day window), and sessions whose order isn't in the database. Queuing those would fail permanently on every run.

## Architecture Decisions

- **BullMQ job scheduler, not `@nestjs/schedule`.** The schedule lives in Redis. When several worker processes run, only one of them takes each run, and a run missed during a restart still happens. `upsertJobScheduler` is idempotent, so every worker can register it at startup. It also appears in Bull Board, which has a **Run now** button for schedulers.
- **A separate `reconciliation` queue for the scheduled run.** A scheduler keeps its next run waiting as a delayed job. On its own queue that job can't mix with Stripe events, their counts or the stage 6 tests. The queue is registered in `QueueModule`, so the API-only process and the dashboard see it; the scheduler and its processor (concurrency 1) live in `WorkerModule`.
- **Repairs go to the existing `stripe-events` queue**, as a second job name, `reconcile-session`. They get the same 5 attempts with backoff, the same worker and the same dashboard. The processor dispatches on `job.name`; an unknown name or missing data is an `UnrecoverableError` (Bull Board's "add job" can create any job, as stage 6 showed).
- **Job ID `reconcile-<sessionId>-<run timestamp>`.** Unique per run, so running reconciliation twice in a day repairs twice instead of being ignored as a duplicate. Applying a session is idempotent, so a duplicate is harmless. Read from the installed BullMQ: custom IDs can't be integers and can't contain `:`, so the parts are joined with `-`.
- **One code path for events and repairs.** The handler's transaction is split from how the snapshot was fetched. Events still mark their `stripe_events` row `PROCESSED` in the same transaction; repairs have no row, so that write is skipped. Failure recording works the same way: a repair job has no event row to save the error on, so its errors live in the job (visible in the dashboard) and the log.
- **Repairs bring refunds back too.** The repair fetches the session with its payment intent and all of the payment intent's refunds. A restored payment therefore comes back with the right refunded total and order status.
- **Window in Unix seconds.** Stripe's `created` filter takes seconds: `gte: floor(now / 1000) - 2 × 86 400`. `now` is a parameter, so a test can pin the window. Sessions are listed page by page through `StripeCalls` (`job=reconciliation` in the log), with a page limit like refunds.

## Decisions for you

1. **Schedule: daily at 03:00 UTC, as a setting `RECONCILIATION_CRON` with that default? (recommended: yes)** A setting lets stage 8's deployment change it without a code change; validated at startup, so a bad cron pattern stops the app.
2. **Manual trigger: the dashboard's "Run now" on the scheduler? (recommended: yes)** No new endpoint to secure; it is already behind the stage 6 login and the cross-site check. The alternative is a `POST /admin/reconcile` endpoint, which would need the same protection.
3. **The "Done when" deletes one row in your development database.** This is destructive, so here is the exact command for your approval. It removes the stage 6 test payment (no refunds, so `ON DELETE RESTRICT` doesn't block it):

   ```sql
   -- saved first, to compare after the repair
   SELECT * FROM payments WHERE stripe_payment_intent_id = 'pi_3UR5EgGImTS0y0Gh01L7xMXK';
   DELETE FROM payments WHERE stripe_payment_intent_id = 'pi_3UR5EgGImTS0y0Gh01L7xMXK';
   ```

   The restored row gets a new UUID and new timestamps. It is compared by payment intent ID, amount, currency and status, plus the order's status.

## The "Done when" check

1. Run the API and a worker. Save the payment row above, then delete it.
2. Open `/admin/queues`, queue `reconciliation`, and click **Run now** on the scheduler.
3. The log shows `checkout.sessions.list job=reconciliation ...` lines and a summary with 1 missing, 1 queued; the stage 4 `stripe trigger` session is counted as skipped.
4. A `reconcile-session` job completes on `stripe-events`. The payment row is back: same payment intent, 4900 cents, `usd`, `SUCCEEDED`; the order is still `PAID`.
5. Run it again: 0 missing, nothing queued.

## Risks

- **Sessions older than 2 days aren't checked.** That is the brief's window. An outage longer than that needs a wider manual run; the window could become a job option later.
- **A paid session whose order was deleted** is skipped and logged, never recreated: orders are created by checkout, not by Stripe.
- **The scheduler's delayed job and e2e cleanup.** Tests must remove the scheduler and empty the `reconciliation` queue afterwards; whether `obliterate` removes schedulers is checked in task 3.
- **The stage 6 admin test expects exactly one queue** on the dashboard. It changes to two, on purpose.
- **`payment_status: paid` covers card payments.** A method that settles later would show `unpaid` at completion and `paid` later; reconciliation would then catch it within the 2-day window. That is the safety net stage 5 promised.

## Task List

Tasks are tracked in `tasks/todo.md`.
