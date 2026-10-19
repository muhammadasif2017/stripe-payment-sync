# Implementation Plan: Stage 9 – Race Fixes

## Overview

A pre-release review of `main` (`/ship`: code review, security audit, test coverage) found no critical issues, but two race conditions in the worker and reconciliation can leave an order in the wrong state for good. Two reviewers found the first one independently. This stage fixes them, closes two smaller gaps the same review found, and adds the tests that were missing around money checks.

Out of scope here, kept for a later hardening branch: a rate limit on `POST /checkout`, a newer Node image pinned by digest, helmet/CSP, `HOST` and `TRUST_PROXY` settings, a Redis password, trimming stored payloads, shutdown order, and a sweep that re-queues lost events.

Stage 1–8 plans and tasks are archived in `tasks/archive/`.

## 1. A repair settles only events that were stored before its snapshot

**The bug.** `reconcileSession` fetches the session, payment intent and refunds from Stripe before its transaction. Inside the transaction it marks every unsettled event of that payment `RECONCILED`, including events stored after the fetch. Example: a repair lists refunds while one is `pending`; the refund then succeeds and `refund.updated` is stored and queued; the repair commits and marks that event `RECONCILED`; the worker skips it. The refund stays `PENDING` and the order `PAID`. Reconciliation never looks again, because the payment is already `SUCCEEDED`.

**The fix.**
- Before the Stripe calls, read the database's clock (`SELECT now()`), not the app's, because `received_at` is set by the database and the two clocks can differ.
- The settling `UPDATE` adds `AND received_at < $snapshotStartedAt`. An event stored before the fetch describes a change that happened before the fetch, so the snapshot already contains it. An event stored later is left `PENDING` and its own job processes it.

## 2. The newest read from Stripe wins

**The bug.** `handle()` also fetches from Stripe before its transaction. The order-row lock makes two jobs for the same order save one at a time, but not in the order they fetched. The payment and refund upserts overwrite the status unconditionally, so an older snapshot that saves last wins. Examples:
- A `charge.refunded` job sees a refund `pending`; a `refund.updated` job sees it `succeeded` and saves first; the first job saves afterwards. Refund back to `PENDING`, order back to `PAID`, never repaired.
- A `payment_intent.payment_failed` job (card declined) saves after the `checkout.session.completed` job of the successful retry. Order shows `PAYMENT_FAILED` until the next daily reconciliation.

**The fix (decision 1).**
- New column `orders.synced_at` (`Timestamptz(3)`, nullable): the `startedAt` of the last snapshot saved for the order. Task 1 already records `startedAt` (database time, before the first Stripe call) on every snapshot.
- Under the order lock, a snapshot older than `synced_at` is not saved. The job reads Stripe again and tries once more, up to 3 reads; after that it fails with a retryable error and BullMQ retries it later.
- A snapshot that is saved sets `synced_at` to its `startedAt`. Equal times are saved (the same instant, so neither is older).
- Repairs follow the same rule, because they write the same rows.

**Why not "never move a status backwards"** (the first recommendation, dropped after checking Stripe's docs): it depends on a list of which status changes Stripe allows. The docs show the list is longer than assumed: a refund that needs the customer's bank details can go from `succeeded` back to `requires_action`. That can't happen with card payments, the only kind this project takes, but the rule would quietly break if another payment method were added. Comparing read times doesn't depend on Stripe's state machine at all.

**Why not fetch Stripe inside the lock:** a network call while holding the order lock, inside the transaction.

## 3. Recording a failure does not undo a settled event

**The bug.** `recordFailure` writes `status` without looking at the current one. If a repair settles an event while that event's job is running, and the job then fails, the row goes back to `PENDING` or `FAILED`.

**The fix.** `updateMany` with `status IN ('PENDING', 'FAILED')`. If no row matched, log that the event was already settled and keep the original error rethrown as today.

## 4. The schedule guard also catches a trailing slash and other letter case

**The bug.** The guard's regexes are case-sensitive and end at `$`. Bull Board's Express router is neither strict nor case-sensitive, so `.../job-schedulers/daily-reconciliation/` and `/API/queues/...` reach the edit and remove handlers. Only a logged-in admin can do this, but "remove" stops the daily reconciliation until the worker restarts.

**The fix.** Allow an optional trailing slash and ignore case: `\/?$/i` on both patterns.

## 5. Tests for checks nothing currently proves

No code change; each test is first shown to fail by breaking the code it covers.
- **Payment intent amount check** (`stripe-event-handler.ts:133`): a `payment_intent.*` event whose PI amount doesn't match the order fails permanently and saves nothing. Today only the session check is reached.
- **Reconciliation's `SUCCEEDED` filter** (`reconciliation.service.ts:59`): a paid session whose only payment row is `FAILED` (an earlier declined card) counts as missing and is repaired.
- **Queue retry settings** (`test/queue.e2e-spec.ts:30`): assert the real values (5 attempts, exponential backoff from 10 s, failed jobs kept) instead of comparing the constant with itself.
- **Login-limit test that only passes in order** (`test/admin-login-limit.e2e-spec.ts:50`): lock the IP out inside the test, so it passes when run alone.

## Decisions

1. **How to stop an older snapshot winning: the newest read wins (decided).** Replaces the first recommendation, "never move a status backwards"; see section 2 for why.
2. **Scope: correctness only (decided).** The checkout rate limit and the Node upgrade are the security audit's two medium findings; they get their own hardening branch next, so this PR stays about one thing.

## Verification

- Every fix starts with a test that fails on today's code (Prove-It), then passes.
  - Task 1: an e2e test where the fake `refunds.list` stores a new `refund.updated` event while the repair runs; that event stays `PENDING` and isn't in the repair's returned list. A second case: an event stored before the repair is still settled.
  - Task 2: e2e: a `charge.refunded` job whose first read is older than a `refund.updated` that saves in between reads Stripe again and ends with the newer state (refund `SUCCEEDED`, order `REFUNDED`); a job whose reads are always older stops after 3 reads with a retryable error and saves nothing; a repair follows the same rule.
  - Task 3: e2e: a stubbed handler sets its event to `RECONCILED`, then throws; the status stays `RECONCILED`.
  - Task 4: unit cases in `schedule-guard.spec.ts` for a trailing slash and `/API/`, for edit and remove; `Run now` still allowed.
- All five checks before each commit; CI green.
- `/ship` again on this branch's diff before the PR.

## Docs

- `docs/BUILD_LOG.md`, `docs/INTERVIEW_PREP.md` (the two races, why the newest read wins rather than "never go backwards" or "fetch inside the lock", why the database clock), `docs/TECH_STACK.md` if anything changes.
- README known limits if one changes. `CLAUDE.md` if a rule changes.

## Housekeeping

The first commit also archives stage 8's plan and tasks (`tasks/archive/stage-8-*.md`, with its last two boxes ticked) and adds `.serena/` to `.gitignore`.

## Task List

Five tasks, tracked in `tasks/todo.md`. One commit per task.
