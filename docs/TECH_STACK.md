# Tech Stack

Why each piece is here. Updated as each stage adds something.

## NestJS 12 (TypeScript)

A Node.js framework that organizes code into modules, controllers and services, and wires them together with dependency injection. The client brief asks for NestJS, and the structure helps here: the webhook endpoint, the queue worker and the reconciliation job are separate modules that share the same database service.

## TypeScript strict mode

The compiler catches mistakes like a possibly-missing value before the code runs. In payment code, a value that is quietly `undefined` can mean a payment is never recorded.

## PostgreSQL 17

The main database for orders, payments, refunds and Stripe events. It supports transactions, so an order and its payment update together or not at all. It also enforces unique keys, which is how each Stripe event gets processed only once (stage 2).

## Prisma 7

The ORM: it turns a schema file into database migrations and a typed client. A typo in a column name becomes a compile error instead of a runtime error. Version 7 connects through a *driver adapter* (`@prisma/adapter-pg`, which uses the `pg` library) instead of a separate query engine binary, so there is less to install.

## Redis 7

An in-memory data store. BullMQ keeps its job queue in Redis from stage 4, so jobs survive an API restart. Redis runs with append-only persistence (`--appendonly yes`) on a named Docker volume, so queued and failed jobs also survive a Redis restart or a recreated container.

## Docker Compose

Starts PostgreSQL and Redis with one command, the same versions on every machine. Nobody has to install a database by hand to run the project.

## @nestjs/config + Joi

`@nestjs/config` loads `.env` and makes settings available through `ConfigService`. Joi checks those settings at startup. A missing secret stops the app straight away with a clear message, instead of failing later on the first payment.

## Vitest

The test runner that NestJS 12 sets up by default. It uses the same `describe`/`it`/`expect` style as Jest and runs fast. `supertest` sends real HTTP requests in the end-to-end tests.

## oxlint and Prettier

oxlint finds likely bugs and bad patterns. Prettier formats code the same way every time. Both came with the NestJS scaffold.

## Prisma Migrate

Every schema change becomes a timestamped SQL file in `prisma/migrations/`, committed with the code. `migrate dev` creates and applies one on a development machine. `migrate deploy` only applies files that already exist, which is what tests, CI and servers run. The database history is then part of the Git history and can be reviewed like code.

## PostgreSQL enums and constraints

Statuses (event, order, payment, refund) are PostgreSQL enum types, so the database refuses an invalid status instead of trusting every piece of code that writes one. Unique indexes on Stripe IDs, `ON DELETE RESTRICT` foreign keys and `CHECK (amount > 0)` constraints work the same way: the rules live in the database, where no code path can skip them. Prisma cannot describe CHECK constraints in its schema, so they are written by hand in the `positive_amount_checks` migration.

## Separate test database

The e2e tests write to `payments_test` in the same PostgreSQL container, never to the development database. A Vitest global setup creates it and runs `prisma migrate deploy` before the tests, so it always has the current schema.

## Stripe Node.js library (`stripe` 23.0.0)

The official library, as the brief asks. It handles authentication, retries network errors with an idempotency key, and has TypeScript types for every request, so a misspelt parameter fails the build instead of a live request. The version is pinned exactly because each major version moves to a new Stripe API version (`2026-09-30.endive` here), and a unit test fails if an upgrade changes it. The client is one NestJS provider (`STRIPE_CLIENT`), so tests swap in a fake and never call Stripe.
## class-validator and ValidationPipe

NestJS's standard way to check request bodies: decorators on a DTO class (`@IsString()`, `@IsEmail()`) and one global `ValidationPipe`. With `whitelist` and `forbidNonWhitelisted`, a body with a field the DTO doesn't declare fails with 400, which is how a client-sent `amount` is refused. `class-transformer` is required by the pipe to turn the JSON into a DTO instance.

## BullMQ 6 and ioredis

BullMQ is a job queue on Redis, as the brief asks. The webhook adds a job and answers Stripe at once; a worker (stage 5) does the work and BullMQ retries it with backoff when it fails. Jobs survive an app restart because they live in Redis, which runs with `appendonly yes` so they survive a Redis restart too. A custom job ID gives deduplication for free: adding a job whose ID already exists is ignored. BullMQ 6 can talk to several backends, so the Redis client (`ioredis`) is a separate install. `@nestjs/bullmq` provides the queue as an injectable NestJS provider.

## Bull Board (`@bull-board/api`, `@bull-board/express`, `@bull-board/nestjs` 9.10.4)

A ready-made web dashboard for BullMQ queues, as the brief asks: it lists waiting, active, completed and failed jobs, shows each job's data and error, and has a retry button. Writing a dashboard by hand would take days for the same result. `@bull-board/nestjs` mounts it as a NestJS module and takes a `middleware` option, which is where the login goes, so the page, its files and its JSON API are all protected by one check. Versions are pinned exactly because the dashboard can change jobs; an upgrade should be a deliberate step.

## HTTP Basic auth (Node's `crypto`, no library)

The dashboard login. The browser shows its own login box when the server answers 401 with `WWW-Authenticate: Basic`, then sends `user:password` in base64 with every request. No sessions, cookies or login page to build. It is about 30 lines, so no library: the user name and password are each hashed with SHA-256 and compared with `crypto.timingSafeEqual`, which takes the same time whether the first or the last character is wrong. Limits: no logout (close the browser), and base64 is not encryption, so outside localhost it must run over HTTPS. Because the browser re-sends the credentials to any request for the dashboard, a second middleware refuses changes that the browser's `Sec-Fetch-Site` or `Origin` header marks as coming from another site.

## BullMQ job schedulers and `cron-parser` 5.10.1

The daily reconciliation is a BullMQ job scheduler, not `@nestjs/schedule` (an in-process timer). The schedule is stored in Redis: with several worker processes only one runs each day's job, a run is not lost to a restart, and the scheduler and its runs show in Bull Board, which has a **Run now** button. No new library: it is part of BullMQ. `cron-parser` is the library BullMQ uses to read cron patterns; it is installed directly, at the same version, so `RECONCILIATION_CRON` is checked at startup with exactly the rules BullMQ will apply.

## `express-rate-limit` 8.7.0

The standard rate limiter for Express. It limits failed dashboard logins to 10 per 15 minutes per IP, counting only 401 responses, and `POST /checkout` to 10 per minute per IP, counting every request (stage 10). It needs no store for one API process; with several, its Redis store would share the counts. Pinned exactly, like the other packages that guard access.

## `helmet` 8.3.0

Sets the standard security headers on every response: a Content-Security-Policy, `X-Content-Type-Options: nosniff`, a strict referrer policy, HSTS, and no `X-Powered-By`. It is the usual choice for Express, and its default policy already fits both pages (scripts only from this site; inline styles and Google Fonts, which Bull Board uses). Two changes: `frame-ancestors 'none'` so no site can frame the dashboard, and no `upgrade-insecure-requests`, which would break the app on plain-HTTP localhost. Pinned exactly (stage 10).

## Docker (multi-stage) and Docker Compose profiles

One image runs as the API or the worker (`WORKER_ENABLED`), so both always run the same code. A multi-stage build compiles with all dependencies and ships only production ones: no TypeScript, no Prisma CLI, no test tools in the running container, which makes it smaller and gives an attacker less to work with. A separate `migrate` target applies migrations once before the app starts. A Compose profile (`app`) keeps `docker compose up -d` meaning "databases for development", while `docker compose --profile app up --build` starts everything. Redis runs with a password and both database passwords are required (`${VAR:?message}`), so Compose refuses to start without them instead of starting with a known or empty one (stage 10).

## Claude Code hooks

The AI coding assistant reads `CLAUDE.md` at the start of each session, but those rules are only advice. A hook is a script the tool runs at fixed points, here before every shell command, and it can block the command. `.claude/hooks/commit-guard.mjs` is plain Node.js with no dependencies, so it runs the same in Git Bash and PowerShell. It only affects the assistant; commits typed by a person go straight to git.
