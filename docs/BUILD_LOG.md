# Build Log

One entry per stage: what was built, what went wrong, and what was decided.

## Stage 1: Project setup (2026-10-09)

### What was built

- A NestJS 12 app in TypeScript with strict mode, created with the Nest CLI.
- `docker-compose.yml` with PostgreSQL 17 and Redis 7. Both have health checks, and both listen on `127.0.0.1` only, so nothing outside this machine can reach them.
- A config module (`src/config/env.validation.ts`) that checks `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` at startup. It lists every problem in one error, rejects live Stripe keys and never prints secret values.
- Prisma 7 with the PostgreSQL driver adapter, wrapped in a global `PrismaService`.
- `GET /health`, which pings the database and returns 200 or 503.

### Problems and fixes

- **Ports already in use.** `docker compose up` failed with `Bind for 127.0.0.1:5432 failed: port is already allocated`. The job-tracker project's containers already used 5432 and 6379. Fix: this project uses 5435 and 6380, set in `.env`.
- **NestJS 12 ships Vitest, not Jest.** `PROJECT.md` names Jest, but the new scaffold is set up for Vitest and ES modules. Kept Vitest: the test code looks the same (`describe`, `it`, `expect`), and swapping it would mean fighting the framework's defaults.
- **Prisma's npm `latest` tag pointed at a release candidate** (`8.0.0-rc.22`). Pinned the last stable version, 7.10.0, instead.
- **`prisma init` added AI-agent skill folders** (`.agents/`, `.claude/`, `.windsurf/`, `skills-lock.json`) and named its config `prisma7.config.ts`. Renamed the config to `prisma.config.ts`, the name the Prisma 7 docs use, and git-ignored the agent folders.
- **`prisma generate` failed without `DATABASE_URL`.** Prisma's `env()` helper throws when the variable is missing, which would break `npm install` in CI or a Docker build. Switched to `process.env.DATABASE_URL`; generating the client needs no database.
- **Empty error in the health check log.** Prisma's error message was blank when the database was down. The log now prints the error name and code, e.g. `PrismaClientKnownRequestError ECONNREFUSED`.
- **Removed the scaffold's "Hello World" root route** (`AppController`, `AppService` and their tests) during code review. It did nothing for the project, and an unused public route is one more thing to secure and explain. `GET /` now returns 404.

### Code review fixes (PR #1)

- **A test that could never fail.** The "does not put secret values in the error message" test called `expect.unreachable()` inside its own `try`, so the `catch` swallowed it. Rewritten to assert the throw first. Checked by removing the secret-hiding message: the test now fails.
- **Health check could hang.** node-postgres waits forever for a connection by default. Added `connectionTimeoutMillis: 5000` to the `PrismaPg` adapter.
- **Redis data was not persistent.** Added a named `redis-data` volume and `--appendonly yes`. Checked: a key survives `docker compose up -d --force-recreate redis`.
- **Health log too thin.** The log now includes the stack trace, and a non-`Error` rejection still returns 503 (new unit test).
- **e2e teardown hid startup errors.** `afterAll` now uses `app?.close()`.
- **`/health` relabelled as a readiness check**, not liveness, because it depends on the database.
- **Deferred to stage 8:** `postinstall` runs `prisma generate`, but `prisma` and `dotenv` are dev dependencies, so `npm ci --omit=dev` would fail. Fix it with the Dockerfile.
- **Startup with the database down** was tested by hand: the app starts, `/health` returns 503, then 200 once the database is back, without a restart.

### Verified

- `npm test`: 15 unit tests pass. `npm run test:e2e`: 1 test passes. `npm run build` and `npm run lint` are clean.
- With a variable removed from `.env`, the app exits with `"STRIPE_WEBHOOK_SECRET" is required`.
- `/health` returned 200, then 503 after `docker compose stop postgres`, then 200 again after `docker compose start postgres`. The app kept running throughout.

## Stage 2: Data model (2026-10-11)

### What was built

- A separate test database, `payments_test`. A Vitest global setup creates it if missing and applies every migration before the e2e tests. A guard refuses to run when `TEST_DATABASE_URL` and `DATABASE_URL` name the same database.
- Migration `init_stripe_events`: the `stripe_events` table, with the Stripe event ID as primary key.
- Migration `orders_payments_refunds`: `orders`, `payments` and `refunds`, linked with `ON DELETE RESTRICT`, each Stripe ID unique, money in integer cents.
- `npm run typecheck` and `npm run db:migrate` scripts.

### Problems and fixes

- **A type error nobody saw.** `test/health.e2e-spec.ts` (from the NestJS scaffold) imported `supertest/types`, which TypeScript cannot resolve under `nodenext` without the `.js` ending. Vitest doesn't type-check and the build skips `test/`, so nothing caught it. Fixed the import and added `npm run typecheck`.
- **Prisma 7 does not regenerate the client after `migrate dev`.** The first test run failed with `Cannot read properties of undefined (reading 'deleteMany')`. Added `npm run db:migrate`, which runs both steps.
- **Prisma blocks `migrate reset` from AI agents** without explicit user consent. To prove the migrations replay on an empty database, they were applied to a throwaway `payments_replay` database instead, then it was dropped.
- **Slower e2e runs.** About 18 seconds instead of 4, mostly the Prisma CLI starting up for `migrate deploy` in the global setup.

### Verified

- `npm test`: 19 unit tests pass. `npm run test:e2e`: 7 tests pass. Build, lint and type check are clean.
- Dropping the primary key on `stripe_events` (test database only) makes the duplicate-event test fail; restoring it makes it pass.
- Switching the payments foreign key to `ON DELETE CASCADE` (test database only) makes the delete test fail; restoring `RESTRICT` makes it pass.
- Both migrations apply cleanly to an empty database. Tests leave no rows behind, and the development database is untouched.
### Code review fixes (PR #2)

- **Missing lifecycle states.** Added `EXPIRED` to orders and `CANCELED` to payments (migration `order_expired_payment_canceled`).
- **No rule against bad amounts.** Hand-written migration `positive_amount_checks` adds `CHECK (amount > 0)` to orders, payments and refunds. Prisma ignores CHECK constraints: a probe migration created afterwards came out empty, so Prisma won't try to drop them. Checked: dropping `payments_amount_positive` in the test database makes the amount tests fail; restoring it makes them pass.
- **A test that depended on another.** The duplicate-event test now inserts its own first row and passes when run alone.
- **Test-database guard compared only names.** It now compares host, port and name, and refuses a test database on another machine unless `ALLOW_REMOTE_TEST_DATABASE=true`.
- **Test clients had no connection timeout.** Both database test files now use one `createTestPrisma()` helper with the same 5-second timeout as `PrismaService`.
- **Slow test setup.** The global setup runs the local Prisma CLI with `node` instead of `npx` through a shell. The e2e run went from about 18 to about 16 seconds.
- **Not changed, documented instead:** 32-bit amounts (fine below about $21 million per row) and per-table currency (one currency only). See `INTERVIEW_PREP.md`, "known limits". No index on `stripe_events.status` yet: in this design the worker gets event IDs from queue jobs, not by scanning the table. Revisit in stage 5 if a query needs it.

After the fixes: 23 unit tests and 10 e2e tests pass; build, lint and type check are clean.
## Tooling: commit guard hook (2026-10-15)

### What was built

- `.claude/settings.json` registers a `PreToolUse` hook for the AI coding assistant. Before the assistant runs any shell command, `.claude/hooks/commit-guard.mjs` checks it. For `git commit` it blocks the command when the message names the assistant (including attribution or `Co-Authored-By` lines), when a `.env` file other than `.env.example` would be committed, or when lint, type check or unit tests fail.
- `.gitignore` now ignores only `.claude/skills/` (downloaded by `prisma init`) and the personal files `.claude/settings.local.json` and `CLAUDE.local.md`, so the shared settings and the hook are committed.
- `test/commit-guard.spec.ts`: 12 unit tests for the rules.

### Why

The same rules were already in `CLAUDE.md`, but an instruction file is advice the assistant can forget. A hook runs every time. The official Claude Code guidance says to use hooks for "actions that must happen every time with zero exceptions".

### Problems and fixes

- **e2e tests and build are not in the hook.** Together with lint, type check and unit tests they would take about a minute on every commit, and e2e needs Docker running. The hook runs the fast checks (about 25 seconds). e2e and build stay a written rule in `CLAUDE.md`.
- **False alarms on file names.** The project has files called `CLAUDE.md` and `.claude/settings.json`, so the hook removes those names before it looks for the word.

### Verified

- `npm test`: 35 unit tests pass. Lint and type check are clean.
- Turning off the word check and the `.env` check makes 8 of the 12 hook tests fail; restoring them makes all pass.
- Run by hand with sample input: a normal command passes (exit 0); a commit naming the assistant is blocked (exit 2); a commit with a type error in `src/` is blocked with the `tsc` error shown; a clean commit passes after the checks.

## Stage 3: Test checkout (2026-10-15)

### What was built

- **Task 1: Stripe client and settings.** `stripe@23.0.0` installed with an exact version. `StripeModule` (global) provides one client under the `STRIPE_CLIENT` token, built from `STRIPE_SECRET_KEY`, with 2 network retries and a 20-second timeout. New setting `APP_URL` (http or https, no trailing slash) for Stripe's success and cancel redirects.
- **Task 2: Course catalog and `course_id`.** `src/checkout/catalog.ts` holds two sample courses with their prices; `findCourse` uses a `Map`, so IDs like `__proto__` find nothing. Migration `order_course_id` adds a required `course_id` column to `orders`.
- **Task 3: Checkout endpoint.** `POST /checkout` takes `{ courseId, email? }`, saves a `PENDING` order with the catalog price, creates a Checkout Session (card only, order ID in `metadata`, `payment_intent_data.metadata` and `client_reference_id`, idempotency key = order ID), saves the session ID on the order and returns `201 { orderId, checkoutUrl }`. A global `ValidationPipe` (`class-validator`) rejects unknown fields, such as `amount`, with 400. If Stripe fails, the client gets a generic 502 and the cause is logged with Stripe's error type and request ID.
- **Task 4: Checkout pages.** `public/index.html` lists the courses from `GET /checkout/courses` (so prices exist only in the catalog) and sends `POST /checkout` with the course ID, then redirects to Stripe. `success.html` says the payment is being confirmed and changes nothing; `cancel.html` says nothing was charged. All three are labelled as a sample project in test mode. `serveCheckoutPages()` in `src/app.setup.ts` serves them with Express's static middleware.

### Problems and fixes

- **`npm audit` reports 9 vulnerabilities.** None come from `stripe`: they are in development tools (`prisma` pulls in `mysql2` and `deepmerge-ts`, `@nestjs/mau` pulls in `tmp` and `undici`) and were already there on `main`. Left as they are; `npm audit fix --force` would install breaking versions. Revisit in stage 8.
- **A required column on an existing table.** Prisma warns that `ADD COLUMN course_id TEXT NOT NULL` fails if `orders` has rows. The development and test databases had none, so it applied cleanly. On a database with orders it would need a default or a backfill first.
- **Prettier reformatted older files.** `.prettierrc` has no `printWidth`, so Prettier wraps at 80 columns while the existing code uses about 100. The formatting-only changes were reverted; only new files were formatted.
- **`payment_method_types` no longer exists.** The type check failed on it: API version `2026-09-30.endive` removed it from Checkout Sessions (library changelog). Its replacement, `allowed_payment_method_types: ['card']`, filters the payment methods Stripe would offer.
- **Validation in `main.ts` would skip the e2e tests.** They build the app from `AppModule`, not `main.ts`, so the `ValidationPipe` is registered in `AppModule` with the `APP_PIPE` token.
- **`@nestjs/serve-static` did nothing in the e2e tests.** It picks its loader when the module is compiled, and `Test.createTestingModule().compile()` runs before the HTTP server exists, so it fell back to a no-op loader and every page returned 404. Its default also answers every unknown GET with `index.html`, hiding API 404s. Replaced with `app.useStaticAssets()` in a setup function that `main.ts` and the e2e test both call; the package was removed.

### Verified

- Task 1: 41 unit tests and 10 e2e tests pass; lint, type check and build are clean. Changing `STRIPE_API_VERSION` makes the version test fail.
- Task 2: 48 unit tests and 10 e2e tests pass. Replacing the `Map` lookup with a plain-object lookup makes the `__proto__` and `constructor` tests fail.
- Task 3: 54 unit tests and 16 e2e tests pass. Removing `payment_intent_data.metadata` and the idempotency key fails the unit test and the e2e happy path; turning off `forbidNonWhitelisted` fails the `amount` test.
- Task 4: 54 unit tests and 21 e2e tests pass. Without the static setup the page tests fail with 404. The built app (`node dist/main.js`) serves `/`, `/success.html` and `/cancel.html` as HTML, `/checkout/courses` and `/health` as JSON, and `/nope` as a JSON 404. The Docker image in stage 8 must copy `public/`.
- Real Stripe error path: with the placeholder key, `POST /checkout` against the real API returned the generic 502, the log line named `StripeAuthenticationError`, and the order stayed `PENDING` with no session ID (the row was deleted afterwards).
- Task 5, real test payment: with a real test key, `POST /checkout` returned 201 both with and without an email. A payment with card 4242 on the checkout page completed: session `cs_test_a1cWrdOHy0iZnEGj3TvkAS7YxikGKEfasae9cB10useScpOWxeFsHNgevO` is `complete` and `paid` (4900 cents, test mode), PaymentIntent `pi_3UQsF1GImTS0y0Gh09xTY4HD` is `succeeded`. Retrieved from the Stripe API, `client_reference_id`, the session's `metadata.order_id` and the PaymentIntent's `metadata.order_id` all equal the order ID. The order is still `PENDING` in the database, as intended until stage 4.
- Sessions that were never paid have no PaymentIntent yet: with this API version Stripe creates it when the customer pays, so `payment_intent_data.metadata` is applied at that moment.

## Stage 4: Webhook endpoint (2026-10-15)

### What was built

- **Task 1: Queue and test Redis.** `bullmq@6.3.10`, `@nestjs/bullmq@12.0.0` and `ioredis@6.0.0` (BullMQ 6 no longer bundles a Redis client). `QueueModule` connects to `REDIS_URL` and registers the `stripe-events` queue: 5 attempts with exponential backoff from 10 seconds, completed jobs kept 7 days, failed jobs kept. The producer connection doesn't buffer commands while Redis is down, so a webhook fails fast instead of hanging. The e2e tests use Redis database 1 (`TEST_REDIS_URL`), with the same guard as the test PostgreSQL database. `test/create-test-app.ts` builds the app with the same options as `main.ts` (`APP_OPTIONS`, now with `rawBody: true`) and the checkout pages.
- **Task 2: Signature check.** `POST /webhooks/stripe` passes the raw body and the `Stripe-Signature` header to `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`. A missing header, a wrong secret, a changed body, a signature older than 5 minutes or a live-mode event gets 400 with a generic message; the reason is logged as a warning. The e2e tests sign their own payloads with `generateTestHeaderString` and a fixed test secret.
- **Task 3: Store and queue.** After the signature check, `WebhooksService.recordEvent` ignores types outside `HANDLED_EVENT_TYPES` (200, nothing saved), inserts the event into `stripe_events` as `PENDING`, treats a duplicate ID (`P2002`) as success, and always adds the job `{ eventId }` with `jobId = event.id`. Any other database or Redis error becomes a 500, so Stripe redelivers the event.

- **The Stripe CLI logs in to live mode by default.** Every CLI command runs with the test key from `.env` as `STRIPE_API_KEY`, so it can only see test mode.
- **`stripe listen` now requires an event selection** (`--events`, `--all-snapshot` or `--all-thin`). `--all-snapshot` forwards everything, which also tests the endpoint's own type filter. `--latest` makes Stripe format the events with the newest API version (`2026-09-30.endive`, the one the code is written for) instead of the account's default (`2020-03-02`).
- **Stripe offered the test customer a price in PKR.** Checkout's Adaptive Pricing shows prices in the customer's local currency; USD was chosen by hand for the test payment. A payment in another currency would reach the worker with a different amount and currency than the order. Decide in stage 5 whether to turn Adaptive Pricing off (`adaptive_pricing: { enabled: false }`) or handle the conversion.

### Verified

- Task 1: 61 unit tests and 23 e2e tests pass. Adding the same job ID twice leaves 1 job; adding the second without the job ID makes the test fail. The development Redis (database 0) stays empty after the tests.
- Task 2: 30 e2e tests pass. Replacing `constructEvent` with `constructEventWithoutVerification` fails the 4 rejection tests; turning off `rawBody` fails the valid-signature test.
- Task 3: 70 unit tests and 35 e2e tests pass. Removing the job ID fails the duplicate tests; skipping the enqueue for duplicates fails the "queue fails, redelivery completes it" test; storing every type fails the unhandled-type test.
- Task 4, real Stripe: `STRIPE_WEBHOOK_SECRET` in `.env` came from `stripe listen --print-secret` (value never printed). With `stripe listen --all-snapshot --latest --forward-to localhost:3000/webhooks/stripe` running, `stripe trigger checkout.session.completed` sent 7 events, all answered 200; exactly 1 was stored (`checkout.session.completed` `evt_1UQsapGImTS0y0GhOVMBJsvY`, `PENDING`) with 1 waiting job of the same ID. `stripe events resend` of that event: 200, logged as duplicate, still 1 row and 1 job. A forged signature and a missing one: 400, nothing saved. A real checkout paid with card 4242 (session `cs_test_a1OrVJC7LSl07HtSJc4m5i9tt6OWiZanv5p7zrpROedR0oNK6wErk4A0dW`) arrived as `evt_1UQsdIGImTS0y0GhoxvmVO9Q`, stored and queued; its `metadata.order_id` matches the order, which stays `PENDING` until stage 5.

## Stage 5: Worker with retries (2026-10-16)

### What was built

- **Task 1: Mapping functions** (`src/worker/mapping.ts`, no database or network). `toPaymentStatus` maps a payment intent to `SUCCEEDED`, `CANCELED`, `FAILED` (declined, back to `requires_payment_method` with an error) or nothing yet. `toRefundStatus` maps refund statuses; unknown ones count as pending. `deriveOrderStatus` computes the order status from succeeded payments and refunds, an expired checkout and declined cards, and refuses refunds above the amount paid with a `PermanentProcessingError`.
- **Task 2: Event handler and transaction.** Each change and why:
  - `src/worker/stripe-event-handler.ts` (new): the brief requires processing to fetch the latest object from Stripe and update order, payment and refund in one transaction. It fetches the session, payment intent or refunds (every page) before the transaction, so no lock is held during network calls; then, inside one transaction, it locks the order row, upserts the payment and refunds on their Stripe IDs, recomputes the order status with `deriveOrderStatus`, and marks the event `PROCESSED`. A missing or unknown `order_id`, an amount or currency that differs from the order, or a Stripe invalid-request error becomes a `PermanentProcessingError`; rate limits, connection and server errors stay retryable.
  - `src/checkout/checkout.service.ts`: `adaptive_pricing: { enabled: false }` (decision 1). Stage 4 showed Checkout offering PKR; a payment in another currency would now fail the amount check, so the session must charge the catalog price in USD.
  - `src/checkout/checkout.service.spec.ts`: the stage 3 test asserts the exact session parameters, so it gains the one new parameter. No other expectation changed.
  - `test/stripe-event-handler.e2e-spec.ts` (new): 12 tests against the test database with a fake Stripe client, one per behaviour in the plan.
- **Task 3: Worker, retries and error recording.** Each change and why:
  - `src/worker/stripe-events.processor.ts` (new): the BullMQ consumer the brief asks for (concurrency 5). It skips events already `PROCESSED`, so a re-run job changes nothing. On failure it saves `attempts` and `last_error` on the event (the brief: "save the error on each failure"), marks it `FAILED` on the last attempt or a permanent error and leaves it `PENDING` otherwise, then rethrows so BullMQ retries; permanent errors become `UnrecoverableError`, which BullMQ fails without retrying. If saving the error fails too, that is logged and the original error still reaches BullMQ.
  - `src/worker/worker.module.ts` (new): groups the processor and handler so they can be switched on or off together.
  - `src/app.module.ts`: loads the worker through `ConditionalModule.registerWhen(WorkerModule, 'WORKER_ENABLED')` (decision 2), so one image can run as API only, worker only, or both.
  - `src/config/env.validation.ts`, `.env.example`: `WORKER_ENABLED`, boolean, default true; a typo stops startup. `src/config/env.validation.spec.ts` gains 2 tests for it.
  - `vitest.config.e2e.ts`: `WORKER_ENABLED=false` and a dummy `STRIPE_SECRET_KEY` for the e2e suite. Without them, every e2e file would start a worker that takes the jobs the webhook tests inspect and calls the real Stripe API with the key in `.env`.
  - `test/worker.e2e-spec.ts` (new): a real worker on the test Redis with a fake Stripe client and a 50 ms backoff on its jobs: success on attempt 1, a database failure retried and completed on attempt 2, 5 failures ending `FAILED` with `attempts = 5`, a permanent error failing after 1 attempt, and an already processed event skipped without calling Stripe.
- **Task 4: Real outage check, refund, and one fix.** Each change and why:
  - `src/worker/stripe-events.processor.ts`: the outage run showed that when loading the event fails (database down), nothing was logged, because that read happened before the error recording. Now that failure is logged and recorded like any other (saving it fails too while the database is down, which is also logged), so an outage is visible at once instead of only when the job gives up.
  - `test/worker.e2e-spec.ts`: one test for that path; it fails without the fix.
  - `README.md`, `CLAUDE.md`, docs: how to run the API and the worker as separate processes, and what was verified.

### Verified

- Task 1: 26 unit tests. Mapping every `requires_payment_method` to `FAILED`, or checking "declined" before "expired", each fails a test.
- Task 2: 96 unit tests and 47 e2e tests pass. Making the expiry non-sticky, removing the amount and currency check, or removing the Stripe error classification each fails exactly its test. The order-row lock is not proven by a test: a race between two transactions can't be forced reliably in a test, so it rests on PostgreSQL's documented `FOR UPDATE` behaviour.
- Task 3: 98 unit tests and 52 e2e tests pass; the worker file passed 5 runs in a row. Counting the attempt as `attemptsMade` instead of `attemptsMade + 1`, retrying permanent errors, or removing the "already processed" skip each fails its test. Two things learned: BullMQ 6 counts the successful attempt in `attemptsMade` once a job finishes (a job that failed once then succeeded reports 2), and a test that reads a job before checking its state can see a stale copy, which made the first version of the test flaky.
- Task 4, the "Done when" with real Stripe: the API ran with `WORKER_ENABLED=false` and `stripe listen`; a checkout paid with card 4242 stored `evt_1UR4WQGImTS0y0GhLaacmGg8` with its job waiting (plus the two events left from stage 4). PostgreSQL was stopped, then a separate worker process started (`WORKER_ENABLED=true`, port 3001): all 3 jobs failed twice on the database and were scheduled for retry. PostgreSQL was started again and attempt 4 completed: both real payments `SUCCEEDED` ($49 and $79), their orders `PAID`, the events `PROCESSED` with `attempts = 4`; the `stripe trigger` event from stage 4 is `FAILED` with "no valid order_id in its metadata", as expected.
- Task 4, refund: `stripe refunds create --amount 1000` on the $49 payment sent `charge.refunded` and `refund.updated`; both were processed on attempt 1, and the order became `PARTIALLY_REFUNDED` (paid 4900, refunded 1000, refund `re_3UR4WPGImTS0y0Gh1mKTiFlx` `SUCCEEDED`). `charge.refund.updated` was answered 200 and ignored, as it is not in the handled list.
- Task 4: 98 unit tests and 53 e2e tests pass; the worker file passed 3 runs in a row. Removing the new failure recording fails the new test.

### Known limits found in stage 5

- **Payment page options.** With Adaptive Pricing off the page shows $49.00 in USD only, but it also offered "Bank" and "Klarna" through Stripe Link, although the session is card-only (`payment_method_types: ["card"]`). Not tested. If a method that settles later were ever used, `checkout.session.completed` would arrive unpaid, no payment would be recorded and the order would stay `PENDING`; the daily reconciliation (stage 7) is the safety net, and `checkout.session.async_payment_succeeded` would need to be handled.
- **Database down on the last attempt.** The event can't be marked `FAILED` if the database is still down at the 5th attempt; it stays `PENDING` while its job is failed in BullMQ. The failed job is visible in the dashboard (stage 6) and reconciliation (stage 7) catches the payment.

## Stage 6: Logging and dashboard (2026-10-16)

### What was built

- **Task 1: Stripe call logging wrapper.** Each change and why:
  - `src/stripe/stripe-calls.ts` (new): the brief asks for every Stripe call to be logged with the event ID, endpoint, status and duration. `StripeCalls.run(endpoint, context, call)` times one call and logs one line, such as `paymentIntents.retrieve event=evt_1 status=200 duration=213ms request=req_ok`. Failures are logged as warnings with the error type (`status=401 (StripeAuthenticationError)`), or `status=no response` when Stripe never answered, and the same error object is thrown again so the worker's retryable-vs-permanent check still works. Parameters, bodies and error messages are never logged, because a Checkout Session carries the customer's email.
  - `src/stripe/stripe.module.ts`: provides and exports `StripeCalls` next to the client.
  - `src/stripe/stripe-calls.spec.ts` (new): 8 unit tests, one per case.
- **Task 2: Every Stripe call goes through the wrapper.** Each change and why:
  - `src/checkout/checkout.service.ts`: `checkout.sessions.create` runs through `StripeCalls` with `order=<id>`, because no Stripe event exists yet at checkout.
  - `src/worker/stripe-event-handler.ts`: `checkout.sessions.retrieve`, `paymentIntents.retrieve` and `refunds.list` run through `StripeCalls` with `event=<id>`. Refunds are now fetched page by page (`has_more` and `starting_after`, 100 per page) instead of with `autoPagingToArray`, so each page is one logged call. A safety limit of 100 pages stops a runaway loop.
  - `src/checkout/checkout.service.spec.ts`, `test/stripe-event-handler.e2e-spec.ts`: pass a `StripeCalls` to the service and the handler. The fake Stripe client now returns refunds one page at a time like the real API. No existing expectation changed.
  - `test/stripe-event-handler.e2e-spec.ts`: new test with 3 refunds on pages of 2; all 3 are recorded and 2 `refunds.list` log lines name the event.
- **Task 3: Bull Board behind Basic auth.** Each change and why:
  - `package.json`: `@bull-board/api`, `@bull-board/express`, `@bull-board/nestjs` at `9.10.4`, exact (the brief: "Mount Bull Board at /admin/queues"). Their peer `@nestjs/bull-shared` was already installed by `@nestjs/bullmq`. `npm audit` still reports the same 9 findings as before; none come from Bull Board.
  - `src/admin/basic-auth.ts` (new): the login (the brief: "behind a login"). Parses `Authorization: Basic ...`, compares SHA-256 hashes of the user name and password with `timingSafeEqual`, and answers anything else with 401 and `WWW-Authenticate`, which makes the browser ask for a login. Rejected attempts are logged with IP and path, never with what was typed.
  - `src/admin/admin.module.ts` (new): mounts Bull Board at `/admin/queues` for the `stripe-events` queue, with the login as Bull Board's own `middleware` option so it covers every path under the route.
  - `src/app.module.ts`: imports `AdminModule`, in every process that serves HTTP (the dashboard needs Redis, not the worker).
  - `src/config/env.validation.ts`, `.env.example`, `vitest.config.e2e.ts`: `ADMIN_USERNAME` (default `admin`, no colon) and `ADMIN_PASSWORD` (required, 16+ characters, value never printed). The e2e suite uses a fixed test password.
  - `test/admin.e2e-spec.ts` (new): the page loads with the right login (proves the board is mounted), the queue is listed, 5 paths ask for a login without one, a wrong password is refused for pages and actions, a failed job is retried through the dashboard API, and cross-origin requests are not approved.
  - `test/worker.e2e-spec.ts`: 3 tests for what the retry button does with a real worker (below).
- **Task 4: Forced failure, dashboard retry, docs, and two fixes from review.** Each change and why:
  - `README.md` (dashboard walkthrough, settings, known limits), `CLAUDE.md` (dashboard URL, `StripeCalls` rule, Stripe CLI path, Prettier width), and these docs.
  - `.env.example`: `ADMIN_PASSWORD` is now empty. The placeholder `replace-with-16-or-more-characters` was 34 characters long, so it passed validation: anyone who copied the file and forgot to change it would have run the dashboard with a password published in the repository. An empty value fails validation, so the app refuses to start until a real password is set. `src/config/env.validation.spec.ts` gains a test for the empty value.
  - `src/admin/same-origin.ts` (new) and `src/admin/admin.module.ts`: after the login, any request that changes something (not GET, HEAD or OPTIONS) is refused with 403 when the browser marks it as coming from another site (`Sec-Fetch-Site` other than `same-origin` or `none`, or an `Origin` that doesn't match the host). See "Cross-site form posts" below.
  - `src/admin/same-origin.spec.ts` (new): 10 unit tests. `test/admin.e2e-spec.ts`: a forged cross-site form POST to "add job" gets 403 and adds nothing; a same-origin pause and resume are allowed.

### Problems and fixes

- **Prettier and the 80-column default, again.** Running Prettier on a changed file rewrapped unrelated lines at 80 columns. Reverted, then formatted with `--print-width 100`, which matches the existing code.
- **What the retry button does to attempt counts.** Bull Board's retry handler calls `job.retry(state)` without BullMQ's `resetAttemptsMade` option, so `attemptsMade` stays at 5. A manual retry is attempt 6: the processor sees it as the last attempt, so it gets one try and no automatic retries. On success the event shows `attempts = 6`; on failure it is `FAILED` again with `attempts = 6`. The history is kept, and a manual retry can't start another 2.5 minutes of retries. Retrying a completed job is harmless: the processor skips events already `PROCESSED`.
- **Cross-site form posts.** The plan assumed CSRF was covered because Bull Board's actions are `PUT` requests with JSON, which a browser only sends cross-site after a CORS preflight the app never approves. Review pointed out two `POST` routes (`add` and `metrics/history/purge`). A test sent what a form on another site would send (`POST .../add`, `text/plain` body, valid Basic credentials): Bull Board answered 200 and added a job with no data. Basic credentials are re-sent by the browser automatically, so that request is possible from any website an admin visits. Fixed with the same-origin check above; the test now gets 403 and no job is added, and removing the check makes it fail again.
- **Bull Board can also add, change and delete jobs.** Its API includes "add job", "update job data", "empty queue" and "obliterate". Its read-only mode would hide the retry button too, so it stays off; the login is the protection. A deleted job loses nothing: the event row stays in `stripe_events`, and stage 7's reconciliation re-queues missing payments.
- **Stripe's own `response` event was not enough.** The library emits `request` and `response` events, which would log every call with no changes where Stripe is called. Reading the installed `RequestSender.js` showed that a connection error or timeout never emits `response`, and the event can't know which Stripe event a call belongs to. A wrapper sees every outcome and gets the event ID passed in plainly.

### Verified

- Task 1: 8 new unit tests pass. Swallowing the error instead of rethrowing it fails 3 of them.
- Task 2: 106 unit tests and 54 e2e tests pass. Stopping after the first page of refunds fails the new pagination test.
- Task 3: 121 unit tests and 69 e2e tests pass. Removing the login middleware fails 6 dashboard tests. The test that loads the page with the right login matters as much as the 401 tests: a board that silently wasn't mounted would answer 404, and "not 200" alone would look like a working login.
- Task 4, the "Done when" with real Stripe:
  - The API ran with `WORKER_ENABLED=false` and `stripe listen`. A checkout paid with card 4242 logged `checkout.sessions.create order=9b9d90ea-… status=200 duration=875ms request=req_BHn5…` and stored `evt_1UR5EiGImTS0y0GhR9DZONIG` with its job waiting.
  - A worker started on port 3001 with `STRIPE_SECRET_KEY=sk_test_wrong`. Each of the 5 attempts logged `checkout.sessions.retrieve event=evt_1UR5Ei… status=401 (StripeAuthenticationError)`, 10, 20, 40 and 80 seconds apart. The event ended `FAILED` with `attempts = 5` and "Invalid API Key provided: sk_test_*rong".
  - `/admin/queues` answered 401 with no login and with a wrong password (logged as a rejected login), and 200 with the password from `.env`. In the browser the job was in the **Failed** list with its error and "attempt #5".
  - The worker restarted with the real key. Clicking **Retry** (then **Confirm**) ran attempt 6: `checkout.sessions.retrieve … status=200 duration=812ms request=req_hUQZ…`. The event is `PROCESSED` with `attempts = 6`, the payment `SUCCEEDED` (4900 cents), the order `PAID`.
  - The 401 log lines have no Stripe request ID: Stripe's authentication errors don't carry one. The line still shows status, error type and duration.
- Task 4 fixes: 132 unit tests and 71 e2e tests pass; lint, type check and build are clean. Bypassing the same-origin check fails the cross-site test.
