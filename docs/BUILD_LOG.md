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