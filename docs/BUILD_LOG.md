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

### Verified

- Task 1: 61 unit tests and 23 e2e tests pass. Adding the same job ID twice leaves 1 job; adding the second without the job ID makes the test fail. The development Redis (database 0) stays empty after the tests.
- Task 2: 30 e2e tests pass. Replacing `constructEvent` with `constructEventWithoutVerification` fails the 4 rejection tests; turning off `rawBody` fails the valid-signature test.
