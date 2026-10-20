# Implementation Plan: Stage 10 – Hardening

## Overview

The stage 9 pre-release review (`/ship`) found no critical issues, but its security audit listed two medium and seven low findings. Stage 9 fixed only the schedule guard (L-1). This stage closes the rest and two gaps found while planning.

Each task fixes one finding, proves the fix with a test that fails without it (Prove-It), runs the five checks, updates `docs/BUILD_LOG.md`, `docs/TECH_STACK.md` and `docs/INTERVIEW_PREP.md`, and is committed on its own.

Stage 1–9 plans and tasks are archived in `tasks/archive/`.

## Facts checked while planning

- **Shutdown order (confirmed bug, not just a finding).** `@nestjs/core` `runShutdownSequence` calls `onModuleDestroy` hooks, then `beforeApplicationShutdown`, then closes the HTTP server, then `onApplicationShutdown` (`node_modules/@nestjs/core/nest-application-context.js:141-148`). `PrismaService` disconnects in `onModuleDestroy`; `@nestjs/bullmq` closes its workers in `onApplicationShutdown` (`bull.explorer.js:29-30`), and `worker.close()` waits for running jobs. So on `SIGTERM` a job that is still running loses its database pool.
- **Node.** Node 22 reaches end of life on 2027-04-30; Node 24 entered maintenance LTS on 2026-10-20 and is supported until 2028-04-30 (`nodejs/Release` `schedule.json`). The latest releases are 22.23.3 (2026-09-23) and 24.22.0 (2026-10-14). Prisma 7.10.0 accepts `^22.12 || >=24.0`; NestJS, BullMQ and Stripe accept `>=20`. `node:24.22.0-alpine` bundles npm 11.19.1.
- **helmet 8.3.0 defaults** (helmet README): `default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests`. It removes `X-Powered-By`. A directive is dropped by setting it to `null`.
- **Pages under that policy.** `public/index.html:29` has an inline `<script>`: `script-src 'self'` would block it, so the checkout page would stop working. Bull Board's page (`@bull-board/ui/dist/index.ejs`) has inline `<style>`, `style=` attributes and a Google Fonts stylesheet (allowed by the default `style-src`), and a `type="application/json"` script that is data, not code.
- **trust proxy.** express-rate-limit's guide recommends a hop count (`app.set('trust proxy', 1)`), never `true`.
- **Payload fields the code reads.** `fetchSnapshot` reads `data.object.id` and `data.object.payment_intent` (a string, or an expanded object); the repair SQL matches `payload->'data'->'object'->>'id'` and `->>'payment_intent'` (`src/worker/stripe-event-handler.ts:286-287`, `:305-347`).

## Tasks

### 1. Rate limit on `POST /checkout` (M-1)

**Problem.** Anyone can create an order row and a Stripe Checkout Session without limit. A flood also uses up the Stripe account's rate limit, which the worker shares, so real events can fail.

**Change.** `express-rate-limit` (already a dependency): 10 requests per minute per IP, only on `POST /checkout` (the page's `GET /checkout/courses` is not limited). Registered as Nest middleware in `CheckoutModule` (`forRoutes({ path: 'checkout', method: RequestMethod.POST })`), so test apps built from `AppModule` get it. 429 with a JSON message, logged with the IP.

**Proof.** New e2e file with its own app (the count is per process, like `admin-login-limit`): the 11th request in a minute gets 429, `GET /checkout/courses` is never limited. Fails with the middleware removed.

### 2. `TRUST_PROXY` and `HOST` settings (L-2, L-4)

**Problem.** Behind a proxy every client has the proxy's IP, so 10 failed logins from anyone lock every admin out (and the new checkout limit would be shared by everyone). `npm run start:dev` listens on all interfaces, putting the dashboard on the LAN over plain HTTP.

**Change.**
- `TRUST_PROXY`: `false` (default), a hop count, or a comma-separated list of IPs or subnets. `true` is refused at startup, because it lets any client choose its IP with `X-Forwarded-For`.
- `HOST`: default `127.0.0.1`; Compose sets `0.0.0.0` for the containers (a container must listen on all interfaces for its port mapping).
- A new `configureApp(app)` in `src/app.setup.ts` applies app-level Express settings. It is called by `main.ts` and `createTestApp`, so e2e tests cover it. `serveCheckoutPages` moves into it.

**Proof.** Unit tests for the validation (`true` refused, numbers and subnets accepted). e2e: with `TRUST_PROXY=1`, `req.ip` follows `X-Forwarded-For` (checked through the login limit's per-IP count); with the default, a forged header changes nothing.

### 3. Security headers with helmet (L-3)

**Problem.** No CSP, no clickjacking protection (the dashboard can be framed by any site), `X-Powered-By: Express` is sent.

**Change.**
- `helmet()` in `configureApp`, with `frame-ancestors 'none'` and without `upgrade-insecure-requests` (the app is served over plain HTTP on localhost; TLS belongs to the proxy in front of a deployment).
- Move the checkout page's inline script to `public/checkout.js` (and the inline styles to a file if the browser check shows they need it), so the default `script-src 'self'` holds.

**Proof.** e2e asserts the headers on `/`, the API and `/admin/queues`, and no `X-Powered-By`. Fails without helmet. Supertest can't see CSP violations, so a browser check with Playwright opens `/` (the course list loads and the button sends its request) and `/admin/queues` with a login (the dashboard renders), and the console must show no CSP errors.

### 4. Shutdown order (confirmed bug)

**Problem.** See "Facts checked". Expected: a running job's database calls fail during shutdown. **Corrected while building:** they don't. Prisma 7 reopens a closed pool on the next query, so the job saves, but the reopened pool is never closed and shutdown depends on that implicit reconnect. The test checks the order instead (the pool closes after the job).

**Change.** Fix it by shutdown phase, not by module order:
- The two processors close their own workers in `onModuleDestroy` (`await this.worker.close()`, from `WorkerHost`), which waits for running jobs.
- `PrismaService` disconnects in `onApplicationShutdown`, the last phase, after the HTTP server has also finished its requests.
- Compose: `stop_grace_period` for the worker long enough for a job with Stripe calls to finish.

**Proof.** e2e: a job is held inside the handler, `app.close()` is called, the job is released; its database writes must land and the job must complete. Fails before the change.

### 5. Re-queue events lost from Redis

**Problem.** An event is stored in `stripe_events` and then queued. If Redis loses the job (data loss, a flushed database, an obliterated queue), the event stays `PENDING` for good: reconciliation only looks for paid sessions with no payment.

**Change.** The daily reconciliation also re-queues `PENDING` events received more than 1 hour ago. The job ID is the event ID, so the add does nothing while the job still exists; only missing jobs come back. The run's summary gains `requeued`.

**Proof.** e2e: a `PENDING` event with no job is re-queued and processed; one with a waiting job and one received 5 minutes ago are left alone.

### 6. Store only the payload fields the code needs (L-7)

**Problem.** `stripe_events.payload` keeps the full event forever, including the customer's email, name and address. The worker re-fetches everything from Stripe and reads only a few fields.

**Change.** Store `id`, `type`, `created`, `livemode`, `api_version` and `data.object` reduced to `id`, `object` and `payment_intent` (an expanded `payment_intent` stored as its ID). Update the schema comment ("kept for debugging and replays").

**Proof.** Unit test of the trimming. e2e: a signed webhook carrying customer details is stored without them and still processed and repaired correctly.

**Decision 2** below: whether existing rows are trimmed too.

### 7. Redis password, required PostgreSQL password (L-5)

**Problem.** Any local process can add, change or delete queue jobs through Redis without the dashboard's login. `POSTGRES_PASSWORD=change-me` stays in use if nobody changes it.

**Change.**
- Compose runs Redis with `--requirepass ${REDIS_PASSWORD:?...}`; the healthcheck and the container URLs use it.
- `POSTGRES_PASSWORD` becomes required (`${POSTGRES_PASSWORD:?...}`) and empty in `.env.example`, like `ADMIN_PASSWORD`.
- The CI `docker` job sets both. CI's `checks` job keeps its own service containers.

**Your machine.** The Redis container is recreated (its data stays in the `redis-data` volume). Your `.env` needs a `REDIS_PASSWORD` and the password in `REDIS_URL` and `TEST_REDIS_URL`; I'll add them without printing them. Your PostgreSQL password doesn't change: it was set when the volume was created.

**Proof.** Redis refuses commands without the password; the stack starts with it; CI's docker job passes.

### 8. Node 24, images pinned by digest, Dependabot, image scan (M-2)

**Change.**
- `node:24.22.0-alpine@sha256:44fce696...` in both `FROM` lines (the multi-arch index digest); CI `node-version: 24.22.0`; `engines` `>=24`; README and `CLAUDE.md`. The global `npm install -g npm@11.14.0` goes if the bundled npm 11.19.1 accepts the lockfile (checked by `npm ci` in the build).
- `postgres` and `redis` images pinned by digest too.
- `.github/dependabot.yml` for npm, docker and github-actions, weekly. Prisma packages (`prisma`, `@prisma/*`) grouped so they move together (`CLAUDE.md`); no major updates for Node or Prisma (npm's `latest` for Prisma is an 8.x release candidate).
- An image scan (Trivy, action pinned by commit) in the CI `docker` job. Run it locally first to see the starting point.

**Proof.** All checks and the CI docker job pass on Node 24; the scan runs.

**Decisions 1 and 3** below.

### 9. Checkpoint

All five checks, the Docker stack started as a separate Compose project, docs complete, a `/ship`-style review of the branch, then the PR.

## Decisions

Plan approved 2026-10-20 with the recommendations.

1. **Node version: 24.22.0.** Node 22's support ends on 2027-04-30, Node 24's on 2028-04-30, and every dependency accepts it.
2. **Existing payloads: trimmed by a migration too** (recommended), so the customer data already stored goes as well; nothing reads the removed fields. This can't be undone, so the user confirms once more before the migration runs on `payments`.
3. **Image scan: CI fails on HIGH or CRITICAL findings that have a fix available.** Unfixed findings can't be acted on and would block every PR.

## Not in this stage

- **Slim migrate image (L-6).** The 4 high audit findings are inside the Prisma CLI, which the migrate image needs; a slimmer image would still contain them. They go away with a Prisma 7.x release that fixes them.
- **Stripe error messages in logs.** They contain no keys or card data; the request parameters and bodies are already never logged.
- **Alerts (OWASP A09).** Needs a deployment's monitoring, out of scope for a local test-mode project.

## Risks

- **CSP breaks a page silently.** Mitigated by the browser check on both pages.
- **Shutdown test timing.** The test controls the job with a promise it resolves itself, not with sleeps.
- **Compose changes break the stack.** The CI docker job starts it on every push; Task 9 also runs it locally as a separate project.
