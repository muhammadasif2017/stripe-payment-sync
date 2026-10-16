# Stage 7 – Daily Reconciliation: Tasks

## Task 1: Repair one Checkout Session

**Description:** The handler can apply a Checkout Session without a Stripe event: fetch the session, its payment intent and refunds, then run the same transaction, without the `stripe_events` write.

**Acceptance criteria:**
- [x] The transaction is shared by events and repairs; only events mark a `stripe_events` row `PROCESSED`
- [x] `reconcileSession(sessionId)` fetches the session with `expand: ['payment_intent']` and every page of that payment intent's refunds, each call logged with `job=reconciliation`
- [x] Same checks as events: valid `order_id`, existing order, amount and currency match (permanent errors otherwise)

**Verification:**
- [x] e2e (fake Stripe, test database): a deleted payment comes back with its refunds and the right order status; running it twice changes nothing; a session without `order_id` fails permanently
- [x] Existing handler and worker e2e tests pass unchanged
- [x] Prove a test can fail (e.g. skip the refunds)

**Dependencies:** None

**Files likely touched:** `src/worker/stripe-event-handler.ts`, `test/stripe-event-handler.e2e-spec.ts`

**Estimated scope:** Medium

## Task 2: `reconcile-session` jobs in the worker

**Description:** The `stripe-events` processor runs two job names: `stripe-event` (as before) and `reconcile-session`.

**Acceptance criteria:**
- [x] Dispatch on `job.name`; an unknown name or missing `eventId` / `sessionId` is an `UnrecoverableError`
- [x] `reconcile-session` failures are logged and retried like events, but never written to `stripe_events`
- [x] Permanent errors fail at once, as for events

**Verification:**
- [x] Worker e2e: a `reconcile-session` job restores a deleted payment; one that fails once is retried and completes; an unknown job name fails without retries
- [x] Prove a test can fail

**Dependencies:** Task 1

**Files likely touched:** `src/worker/stripe-events.processor.ts`, `src/queue/queue.module.ts`, `test/worker.e2e-spec.ts`

**Estimated scope:** Small to medium

## Checkpoint: Repair path
- [x] Tasks 1–2 verified, all five checks pass, commit

## Task 3: The reconciliation run and its schedule

**Description:** A `reconciliation` queue with a daily job scheduler; its processor finds missing payments and queues repairs.

**Acceptance criteria:**
- [x] `reconciliation` queue registered in `QueueModule` and shown in Bull Board
- [x] `RECONCILIATION_CRON` setting (default `0 3 * * *`, UTC), validated at startup, in `.env.example`
- [x] Worker registers the scheduler with `upsertJobScheduler` at startup; processor concurrency 1
- [x] Lists `complete` sessions created in the last 2 days (seconds), every page through `StripeCalls` with a page limit
- [x] Missing = paid session, valid and existing order, no `SUCCEEDED` payment for its payment intent (one `findMany`)
- [x] Queues `reconcile-session` with job ID `reconcile-<sessionId>-<run timestamp>`
- [x] Logs one summary: checked, skipped (no order ID / unknown order / not paid), missing, queued

**Verification:**
- [x] Unit tests for the window (pinned `now`), pagination and the selection rule
- [x] e2e: with a fake Stripe client, one missing payment is queued, a present one is not, the `stripe trigger`-style session is skipped; a second run queues again with a different job ID
- [x] e2e: the dashboard's scheduler **Run now** route queues a reconciliation job; the `reconciliation` queue is listed
- [x] e2e cleanup removes the scheduler and the queue's jobs
- [x] Prove a test can fail (e.g. use milliseconds for the window)

**Dependencies:** Task 2

**Files likely touched:** `src/reconciliation/*`, `src/queue/queue.module.ts`, `src/worker/worker.module.ts`, `src/admin/admin.module.ts`, `src/config/env.validation.ts`, `.env.example`, tests

**Estimated scope:** Medium

## Checkpoint: Reconciliation
- [x] Tasks 1–3 verified, all five checks pass, commit

## Task 4: Delete-and-restore check, docs and pull request

**Description:** Run the "Done when" for real (the delete approved in decision 3), document, open the PR.

**Acceptance criteria:**
- [x] Payment row saved, deleted, reconciliation run from the dashboard, row back with the same payment intent, amount, currency and status; order `PAID`
- [x] Summary log shows 1 missing, 1 queued, the `stripe trigger` session skipped; a second run queues nothing
- [x] `README.md`, `CLAUDE.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md` (why reconciliation, why not re-queue events, the selection rule, job schedulers)
- [ ] PR from `stage-7-reconciliation` to `main`

**Verification:**
- [x] Manual check with Docker, the browser and database queries

**Dependencies:** Tasks 1–3

**Files likely touched:** `README.md`, `CLAUDE.md`, `docs/*.md`

**Estimated scope:** Small to medium

## Checkpoint: Stage 7 complete
- [x] All five checks pass
- [x] Stage 7 "Done when" from `PROJECT.md` met
- [ ] Commit, push, open PR
- [ ] Human review and merge before stage 8
