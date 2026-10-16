# Stage 6 – Logging and Dashboard: Tasks

## Task 1: Stripe call logging wrapper

**Description:** A `StripeCalls` service whose `run(endpoint, context, call)` times one Stripe call, logs one line and returns or rethrows unchanged.

**Acceptance criteria:**
- [x] Success: one `log` line with endpoint, event or order ID, status and request ID from `lastResponse`, duration in ms
- [x] Failure with a response (e.g. 401, 404, 429): one `warn` line with status, error type and request ID; the same error object is rethrown
- [x] Failure with no response (`StripeConnectionError`, timeout): `status=no response` with the error type and duration
- [x] A result without `lastResponse` (test fakes) logs `status=ok` instead of failing
- [x] Never logs parameters or bodies

**Verification:**
- [x] Unit tests for each case above, with a fake call and a spied logger
- [x] Unit test: a call whose parameters include an email produces log output without it
- [x] Prove a test can fail (e.g. swallow the error instead of rethrowing)

**Dependencies:** None

**Files likely touched:** `src/stripe/stripe-calls.ts`, `src/stripe/stripe-calls.spec.ts`, `src/stripe/stripe.module.ts`

**Estimated scope:** Small

## Task 2: Route every Stripe call through the wrapper

**Description:** The checkout service and the event handler call Stripe through `StripeCalls.run`; refunds are listed page by page.

**Acceptance criteria:**
- [x] `checkout.sessions.create` logged with `order=<id>`
- [x] `checkout.sessions.retrieve`, `paymentIntents.retrieve`, `refunds.list` (each page) logged with `event=<id>`
- [x] Refund listing follows `has_more` / `starting_after` with a page limit, and still returns every refund
- [x] Error classification (invalid request is permanent, the rest retryable) unchanged

**Verification:**
- [x] Existing unit and e2e tests pass without changing their expectations
- [x] New e2e test: refunds spread over 2 pages are all recorded
- [x] Prove a test can fail (e.g. stop after the first page)

**Dependencies:** Task 1

**Files likely touched:** `src/checkout/checkout.service.ts`, `src/worker/stripe-event-handler.ts`, their tests

**Estimated scope:** Small to medium

## Checkpoint: Logging
- [x] Tasks 1–2 verified, all five checks pass, commit

## Task 3: Bull Board behind Basic auth

**Description:** Mount Bull Board at `/admin/queues` for the `stripe-events` queue, protected by a Basic auth middleware.

**Acceptance criteria:**
- [x] `@bull-board/api`, `@bull-board/express`, `@bull-board/nestjs` installed at `9.10.4` (exact); `@nestjs/bull-shared` present
- [x] `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (required, 16+ characters, value never printed) in `env.validation.ts`, `.env.example` and the e2e config
- [x] Credentials compared as SHA-256 hashes with `timingSafeEqual`; failures logged without the submitted values
- [x] Missing or wrong credentials: `401` with `WWW-Authenticate: Basic realm="admin"`
- [x] Bull Board's retry behaviour read from the installed code (`resetAttemptsMade` passed or not) and written down

**Verification:**
- [x] Unit tests for the auth middleware: right, wrong user, wrong password, malformed header, missing header
- [x] e2e: with correct credentials `/admin/queues` returns `200` HTML (proves the board is mounted)
- [x] e2e: without credentials `401` on `/admin/queues`, `/admin/queues/`, an API route and a static file
- [x] e2e: a failed job is retried through the dashboard's API route and moves back to waiting
- [x] Worker e2e: a manual retry of a failed job records the attempt count found above and completes
- [x] e2e: a dashboard action sent cross-origin without a CORS preflight is not approved
- [x] Prove a test can fail (e.g. register the middleware on the wrong path)

**Dependencies:** None (can run in parallel with tasks 1–2)

**Files likely touched:** `src/admin/admin.module.ts`, `src/admin/basic-auth.middleware.ts`, its spec, `src/app.module.ts`, `src/config/env.validation.ts`, `.env.example`, `vitest.config.e2e.ts`, `test/admin.e2e-spec.ts`, `test/worker.e2e-spec.ts`

**Estimated scope:** Medium

## Checkpoint: Dashboard
- [x] Tasks 1–3 verified, all five checks pass, commit

## Task 4: Forced failure check, docs and pull request

**Description:** Run the "Done when" for real (method chosen in decision 2), document, open the PR.

**Acceptance criteria:**
- [x] A real event fails all 5 attempts; each failed Stripe call is logged with its event ID, status and duration
- [x] The failed job shows on `/admin/queues` after logging in; wrong credentials are refused
- [x] Retry from the dashboard completes it: event `PROCESSED`, payment `SUCCEEDED`, order `PAID`
- [x] `README.md`, `CLAUDE.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md` (why a wrapper, why Basic auth, what a manual retry means, why retrying a completed job is harmless)
- [x] PR from `stage-6-logging-dashboard` to `main`

**Verification:**
- [x] Manual check with Docker, the Stripe CLI, the browser and database queries

**Dependencies:** Tasks 1–3

**Files likely touched:** `README.md`, `CLAUDE.md`, `docs/*.md`

**Estimated scope:** Small to medium

## Checkpoint: Stage 6 complete
- [x] All five checks pass
- [x] Stage 6 "Done when" from `PROJECT.md` met
- [x] Commit, push, open PR
- [ ] Human review and merge before stage 7
