# Stage 9 – Race Fixes: Tasks

## Task 1: A repair settles only events stored before its snapshot

**Acceptance criteria:**
- [x] `reconcileSession` reads the database clock before its Stripe calls
- [x] The settling `UPDATE` adds `received_at < snapshotStartedAt`
- [x] Events stored before the snapshot are still settled, as today

**Verification:**
- [x] e2e: an event stored while the repair runs stays `PENDING` and is not returned
- [x] e2e: an event stored before the repair is still `RECONCILED` (the existing settling test)
- [x] The first test fails on today's code
- [x] Docs updated; stage 8 archive and `.gitignore` (`.serena/`) in this commit

**Files likely touched:** `src/worker/stripe-event-handler.ts`, `test/stripe-event-handler.e2e-spec.ts`, `.gitignore`, `tasks/`

## Task 2: The newest read from Stripe wins

**Acceptance criteria:**
- [x] Migration: `orders.synced_at` (`Timestamptz(3)`, nullable)
- [x] Under the order lock, a snapshot with `startedAt` older than `synced_at` is not saved; the job reads Stripe again, up to 3 reads, then fails with a retryable error
- [x] A saved snapshot sets `synced_at` to its `startedAt`
- [x] Event jobs and repairs both follow the rule

**Verification:**
- [x] e2e: a stale `charge.refunded` read, overtaken by a `refund.updated` save, reads again and ends `SUCCEEDED` / `REFUNDED`
- [x] e2e: reads that are always stale stop after 3 with a retryable error and save nothing
- [x] e2e: a stale repair reads again too
- [x] The first test fails on today's code
- [x] Docs updated

- [x] `received_at` set by a `BEFORE INSERT` trigger (replaces Task 1's `dbgenerated` default); fake-clock test fails without it

**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/`, `src/worker/stripe-event-handler.ts`, `test/stripe-event-handler.e2e-spec.ts`

## Task 3: Recording a failure does not undo a settled event

**Acceptance criteria:**
- [x] `recordFailure` only updates rows with status `PENDING` or `FAILED`
- [x] A skipped update is logged; the original error is still rethrown

**Verification:**
- [x] e2e: a handler that settles its event and then throws leaves it `RECONCILED`
- [x] The test fails on today's code
- [x] Docs updated

**Files likely touched:** `src/worker/stripe-events.processor.ts`, `test/worker.e2e-spec.ts`

## Task 4: Schedule guard catches a trailing slash and other letter case

**Acceptance criteria:**
- [x] Both patterns accept an optional trailing slash and ignore case
- [x] `Run now` stays allowed

**Verification:**
- [x] Unit: trailing slash and `/API/` for edit and remove are refused; `Run now` passes
- [x] The new cases fail on today's code
- [x] Docs updated

- [x] e2e: the same requests through the real app get 403 and leave the scheduler unchanged

**Files likely touched:** `src/admin/schedule-guard.ts`, `src/admin/schedule-guard.spec.ts`

## Task 5: Tests for checks nothing currently proves

**Acceptance criteria:**
- [x] A `payment_intent.*` event with a mismatched PI amount fails permanently and saves nothing
- [x] Reconciliation repairs a paid session whose only payment row is `FAILED`
- [x] Queue retry settings asserted by value
- [x] Login-limit "only the dashboard" test passes when run alone

**Verification:**
- [x] Each test fails when the code it covers is broken, then the code is restored
- [x] Docs updated

**Files likely touched:** `test/stripe-event-handler.e2e-spec.ts`, `test/reconciliation.e2e-spec.ts`, `test/queue.e2e-spec.ts`, `test/admin-login-limit.e2e-spec.ts`

## Checkpoint: Complete
- [ ] All five checks pass locally and in CI
- [ ] `/ship` on the branch diff: GO
- [ ] Commit, push, open PR
- [ ] Human review and merge
