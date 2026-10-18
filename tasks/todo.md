# Stage 7 Follow-up – Closing Reconciliation's Known Limits: Tasks

## Task 1: Repairs resolve the events they cover

**Description:** Settle the stuck events of a repaired payment in the repair's transaction; clear their failed jobs.

**Acceptance criteria:**
- [x] Migration: `RECONCILED` added to `stripe_event_status`; hand-written partial index on `stripe_events (status) WHERE status <> 'PROCESSED'`
- [x] Repair transaction sets `RECONCILED` on `PENDING` / `FAILED` events whose `data.object.id` is the session or payment intent, or whose `data.object.payment_intent` is the payment intent; `last_error` and `attempts` kept
- [x] After commit, each settled event's failed job is removed (decision 1); a failure to remove is logged, not thrown
- [x] Processor skips `RECONCILED` events like `PROCESSED` ones

**Verification:**
- [x] e2e: a stuck `checkout.session.completed` event and a `FAILED` refund event of the same payment become `RECONCILED`; a `PROCESSED` event and another payment's event are untouched; the failed job is gone
- [x] e2e: a repair that fails changes no event (transaction rolled back)
- [x] Migrations apply cleanly to an empty throwaway database
- [x] Prove a test can fail

**Dependencies:** None

**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/*`, `src/worker/stripe-event-handler.ts`, `src/worker/stripe-events.processor.ts`, tests

**Estimated scope:** Medium

## Task 2: Unrepairable sessions become recorded issues

**Description:** Record permanent repair failures once; skip them in later runs; remind daily.

**Acceptance criteria:**
- [x] Migration: `reconciliation_issues` (session ID unique, order ID, reason, first/last seen, resolved at)
- [x] Processor upserts an open issue on a permanent `reconcile-session` failure; a failure to save is logged, never replaces the original error
- [x] Reconciliation skips sessions with an open issue, counts them as `openIssues`, and logs a warning when there are any
- [x] A resolved issue (`resolved_at` set) is tried again; failing again reopens it

**Verification:**
- [x] Unit tests for the selection with open issues
- [x] e2e: an amount mismatch is recorded once; the next run skips it and reports it; resolving it lets it be retried
- [x] Prove a test can fail

**Dependencies:** None (shares the migration step with task 1)

**Files likely touched:** `prisma/*`, `src/reconciliation/*`, `src/worker/stripe-events.processor.ts`, tests

**Estimated scope:** Medium

## Checkpoint: Data changes
- [x] Tasks 1–2 verified, all five checks pass, commit

## Task 3: Schedule changes only through the setting

**Description:** The dashboard guard refuses Bull Board's edit-scheduler and remove-scheduler routes.

**Acceptance criteria:**
- [x] `PATCH .../job-schedulers/:id` and `PUT .../job-schedulers/:id/remove` get `403` with "Change RECONCILIATION_CRON instead"
- [x] `PUT .../job-schedulers/:id/run` still allowed

**Verification:**
- [x] Unit tests for the route matching; e2e for the three routes with a real worker
- [x] Prove a test can fail

**Dependencies:** None

**Files likely touched:** `src/admin/*`, `test/reconciliation-schedule.e2e-spec.ts`

**Estimated scope:** Small

## Task 4: Manual check, docs and pull request

**Acceptance criteria:**
- [ ] Decision 2's check: the event becomes `RECONCILED`, the payment is back, the failed job is gone; Edit and Remove scheduler refused against the running app
- [ ] `README.md` known limits, `CLAUDE.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md`
- [ ] PR from `stage-7-followup-limits` to `main`

**Dependencies:** Tasks 1–3

**Estimated scope:** Small

## Checkpoint: Complete
- [ ] All five checks pass
- [ ] Commit, push, open PR
- [ ] Human review and merge before stage 8
