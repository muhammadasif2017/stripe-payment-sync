# Implementation Plan: Stage 7 Follow-up – Closing Reconciliation's Known Limits

## Overview

Stage 7 shipped with three known limits, listed in the README. This follow-up closes them in one small PR, before stage 8:

1. **A repair fixes the payment, not the event history.** An event that got stuck stays `PENDING` or `FAILED`, and its job stays in the dashboard's Failed list.
2. **A paid session that doesn't match its order fails its repair every day**, adding a new failed job each time.
3. **Schedule edits on the dashboard are undone** at the next worker start.

Stage 1–7 plans and tasks are archived in `tasks/archive/`.

## 1. Repairs resolve the events they cover

When a repair writes a payment, the events about that payment are now settled too.

- **Which events:** status `PENDING` or `FAILED`, whose `data.object.id` is the repaired session or its payment intent, or whose `data.object.payment_intent` is that payment intent. That last condition covers `charge.refunded` and `refund.updated`, and the repair writes the refunds too.
- **New status `RECONCILED`,** not `PROCESSED`. The history then says a repair settled the event, not the event itself. `last_error` and `attempts` stay as they were, as a record of what went wrong.
- **Same transaction as the repair.** Payment, refunds, order status and the events' new status commit together or not at all.
- **Index.** A hand-written partial index on `stripe_events (status) WHERE status <> 'PROCESSED'`. Almost every row is `PROCESSED`, so the index stays tiny, and the lookup only reads the few unsettled rows before checking their JSON. Stage 2 deferred a status index "until a query needs it"; this is that query.
- **The dashboard's Failed list.** After the transaction commits, each settled event's failed job (job ID = event ID) is removed from Redis (decision 1). The error stays on the event row.
- **The processor** skips `RECONCILED` events like `PROCESSED` ones, so a late redelivery or a manual retry changes nothing.

## 2. A repair that can't succeed becomes one recorded issue

- **New table `reconciliation_issues`:**

  | Column | Meaning |
  | --- | --- |
  | `stripe_checkout_session_id` | unique |
  | `order_id` | nullable |
  | `reason` | the repair's error message |
  | `first_seen_at`, `last_seen_at` | |
  | `resolved_at` | null while open |

- **Recorded by the worker:** when a `reconcile-session` repair fails with a permanent error (amount or currency mismatch, unknown order, session Stripe doesn't know), the processor upserts an open issue for that session. A failure to save the issue is logged and never replaces the original error, the same rule as stage 5's error recording.
- **Read by reconciliation:** sessions with an open issue are skipped and counted as `openIssues` in the summary. Every run with open issues also logs a warning: `N open reconciliation issues need review`. One failed job and one row per problem, then silence apart from that daily reminder.
- **Resolving:** set `resolved_at`. The next run then tries the session again; if it still fails, the issue reopens with a new `last_seen_at`. This is SQL for now. A dashboard or endpoint for it is out of scope.
- **Not issues:** sessions without an order ID (`stripe trigger` tests) stay a plain skip count, as today.

## 3. The schedule is changed only through `RECONCILIATION_CRON`

- A third check in the dashboard's guard, after the login and the cross-site check, refuses Bull Board's two scheduler-changing routes with `403` and the message "Change RECONCILIATION_CRON instead". The routes, read from Bull Board's route list in stage 7:
  - `PATCH /api/queues/:queue/job-schedulers/:id` (Edit schedule)
  - `PUT /api/queues/:queue/job-schedulers/:id/remove` (Remove scheduler)
- **Run now** (`PUT .../job-schedulers/:id/run`) stays allowed.
- The buttons stay visible, because Bull Board can't hide single buttons; clicking them shows the error.

## Architecture Decisions

- **`RECONCILED` instead of reusing `PROCESSED`.** "The worker processed it" and "a repair made it right" are different facts, and the difference is what an audit or a debugging session needs.
- **Issues in the database, not only in Redis.** Failed jobs are pruned, can be removed from the dashboard, and live in another store. A row next to the orders is easy to query, join and keep.
- **Guard in code, not in Bull Board settings.** Bull Board's read-only mode would also hide Retry and Run now.

## Decisions for you

1. **Remove a settled event's failed job from the dashboard? (recommended: yes)** The Failed list then means "needs attention". The error stays on the event row. The alternative is to leave it there, marked settled only in the database.
2. **Manual check in your development database? (recommended: yes)** The e2e tests cover every case, but a real run shows it end to end. It changes your data again, so here are the exact commands. They use the stage 6 payment and its event `evt_1UR5EiGImTS0y0GhR9DZONIG`, which has no refunds:

   ```sql
   UPDATE stripe_events SET status = 'FAILED' WHERE id = 'evt_1UR5EiGImTS0y0GhR9DZONIG';
   DELETE FROM payments WHERE stripe_payment_intent_id = 'pi_3UR5EgGImTS0y0Gh01L7xMXK';
   ```

   Then **Run now**. Expected: the payment comes back, and the event becomes `RECONCILED`. The schedule-edit refusal is checked against the running app with curl; no data change is needed for that.

## Risks

- **Adding an enum value in PostgreSQL** (`ALTER TYPE ... ADD VALUE`) can't be used in the same transaction that adds it. Prisma runs each migration in its own transaction and the code uses the value only afterwards, so this is fine. Checked by applying the migration to the test database and to a throwaway database.
- **Matching events by JSON.** The payload is Stripe's event as received. Refund events carry `payment_intent` as a string in API version `2026-09-30.endive`, which the handler already relies on.
- **The README's known-limits list shrinks.** The three items are replaced by how each case is now handled.

## Task List

Tasks are tracked in `tasks/todo.md`.
