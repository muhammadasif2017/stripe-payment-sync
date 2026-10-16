# Implementation Plan: Stage 6 – Logging and Dashboard

## Overview

Stage 6 makes the system observable (see `PROJECT.md`, stage 6). Every call to the Stripe API is logged with the event ID, endpoint, status and duration. Bull Board, a web dashboard for BullMQ queues, is mounted at `/admin/queues` behind a login, so failed jobs can be seen and retried by hand.

**Done when (from `PROJECT.md`):** a forced failure appears on the dashboard and its retry button works.

Stage 1–5 plans and tasks are archived in `tasks/archive/`.

## Part 1: Logging each Stripe call

### What a log line looks like

```
[StripeCalls] paymentIntents.retrieve event=evt_1UR4... status=200 duration=213ms request=req_8f...
[StripeCalls] checkout.sessions.create order=4b1e... status=200 duration=640ms request=req_2c...
[StripeCalls] checkout.sessions.retrieve event=evt_1UR4... status=401 (StripeAuthenticationError) duration=180ms request=req_91...
[StripeCalls] refunds.list event=evt_1UR4... status=no response (StripeConnectionError) duration=20004ms
```

Successful calls are logged at `log` level, failed calls at `warn`. Request and response bodies are never logged: a Checkout Session carries the customer's email.

### Shape: one wrapper function every Stripe call goes through

A small `StripeCalls` service with one method, `run(endpoint, context, call)`:

- `endpoint` is a fixed name such as `'paymentIntents.retrieve'`, written at the call site.
- `context` says what the call is for: `{ eventId }` in the worker, `{ orderId }` in checkout (no event exists yet), and later `{ job: 'reconciliation' }` in stage 7.
- It starts a timer, runs the call, and logs one line. On success it reads the status and request ID from the result's `lastResponse`. On failure it reads them from the Stripe error, then rethrows the **same** error, so the handler's retryable-vs-permanent classification keeps working.

The handler and the checkout service call `this.stripeCalls.run(...)` around each Stripe call. Refunds are listed page by page (100 per page) instead of with `autoPagingToArray`, so each page is one call and one log line.

### Why this shape and not Stripe's built-in events

The Stripe library emits `request` and `response` events, and listening to them would need no change at the call sites. Reading the installed library (`stripe@23.0.0`, `RequestSender.js`) showed two gaps:

- **No `response` event when no response arrived.** A connection error or a timeout goes straight to the error callback. Those are exactly the failures this stage is meant to show.
- **The event knows nothing about the job.** The client is one shared object, so it can't tell which Stripe event a call belongs to. That would need `AsyncLocalStorage` (a per-request context Node carries across `await`), which works but hides where the ID comes from.

The wrapper covers both: it sees every outcome, including thrown errors without a response, and the event ID is passed in plainly. What it can't see: the library's own 2 network retries happen inside one call. They show up as a longer duration, and Stripe's connection-error message says how many retries were made.

## Part 2: Bull Board at `/admin/queues`

- Packages: `@bull-board/api`, `@bull-board/express` and `@bull-board/nestjs`, all `9.10.4` (exact). Their peer ranges accept BullMQ 6, NestJS 12 and Express 5. `@nestjs/bull-shared` is a peer dependency; check it is installed (it comes with `@nestjs/bullmq`) and pin it if not.
- `BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter, middleware })` and `BullBoardModule.forFeature({ name: STRIPE_EVENTS_QUEUE, adapter: BullMQAdapter })`, in a new `AdminModule`.
- **Login: HTTP Basic auth** (decision 1), passed as the module's `middleware` option so it covers the page, its static files and its JSON API (`/admin/queues/api/...`).
  - New settings: `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (required, at least 16 characters, with a custom message that never prints the value).
  - The check hashes both sides with SHA-256 and compares with `crypto.timingSafeEqual`. Comparing the hashes keeps the comparison time the same whatever the input, and `timingSafeEqual` needs equal lengths, which hashes always have.
  - Wrong or missing credentials get `401` with `WWW-Authenticate: Basic realm="admin"`, so the browser shows its login box. Failed attempts are logged as warnings, without the submitted values.
- The dashboard is mounted in every process that serves HTTP, so the API-only process from stage 5 has it too. It only needs Redis, not the worker.

### What the retry button does

Bull Board's retry calls BullMQ's `job.retry()`. That moves a failed job back to waiting. Whether it resets `attemptsMade` depends on an option (`resetAttemptsMade`) that Bull Board may or may not pass; this is read from the installed code during task 3, not assumed.

- **If it doesn't reset:** the manual retry runs as attempt 6. The processor sees `6 >= 5`, so it is a single attempt with no automatic retries behind it. If it fails, the event is `FAILED` again with `attempts = 6`. That is a sensible meaning for a manual retry, and the event keeps its full count.
- **If it does reset:** the retry gets 5 fresh attempts, and the event's `attempts` restarts from 1. The plan would then record that the count is per run, not total.

Whichever is real gets a worker e2e test and a sentence in the docs. Retrying a **completed** job from the dashboard is harmless either way: the processor skips events that are already `PROCESSED` without calling Stripe or writing anything.

## Architecture Decisions

- **Wrapper function, not a proxy around the client.** A proxy that intercepts every property of the Stripe client is clever but hard to type and hard to read. One `run()` call per Stripe call site is explicit; there are 4 call sites today.
- **Logs never contain bodies or secrets.** Only the endpoint name, status, error type, duration, Stripe request ID, and the event or order ID. The Stripe request ID is what Stripe support asks for.
- **Basic auth, not a login page.** A form login needs sessions, cookies and CSRF protection, none of which this project has otherwise. Basic auth is built into every browser. Its limits: no logout button (close the browser), and the password is only base64-encoded, so outside localhost the dashboard must sit behind HTTPS (stage 8's deployment notes).
- **CSRF.** The browser re-sends Basic credentials automatically, so another site could try to trigger dashboard actions. Bull Board's `PUT` actions need a CORS preflight, which this app never approves. Its `POST` routes don't when sent as a plain form, which review caught in task 4: a same-origin check (`Sec-Fetch-Site` / `Origin`) now refuses state-changing requests from other sites.
- **Destructive dashboard buttons stay available.** Bull Board can also remove jobs and empty the queue. Its read-only mode would hide the retry button too, so it is not used. Removing a job is recoverable: the event row stays in `stripe_events`, and stage 7's reconciliation re-queues missing payments.

## Decisions for you

1. **Login: HTTP Basic auth? (recommended: yes)** The browser's own login box; no sessions, cookies or CSRF tokens to build. The alternative is a login form with sessions, which is a stage of its own.
2. **How to force the failure for "Done when"? (recommended: a wrong Stripe key)**
   - **Wrong Stripe key (recommended).** Start a worker with `STRIPE_SECRET_KEY=sk_test_wrong`. It passes validation, and Stripe answers 401, which the handler treats as retryable. All 5 attempts fail, each Stripe call is logged with `status=401`, the event becomes `FAILED`, and the job sits in the dashboard's failed list. Restart the worker with the real key, click retry, and the event becomes `PROCESSED`. One run shows both halves of stage 6.
   - **Stop PostgreSQL.** Works, but hits stage 5's known limit: while the database is down the event row can't be marked `FAILED`, so it stays `PENDING` even though its job failed. The dashboard still shows it, but the database and the dashboard disagree until the retry.

## The "Done when" check (with decision 2's recommended option)

1. Run the API with `WORKER_ENABLED=false` and `stripe listen`; make a test payment. The event is stored, its job waits.
2. Start a worker process (`WORKER_ENABLED=true`, port 3001) with `STRIPE_SECRET_KEY=sk_test_wrong`. Each attempt logs a `status=401` line with the event ID; after 5 attempts (about 2.5 minutes) the event is `FAILED`.
3. Open `/admin/queues`: the browser asks for a login; wrong credentials are refused. With the right ones, the job is in the failed list with its error.
4. Stop the worker, start it again with the real key, click **Retry**. The job completes: event `PROCESSED`, payment `SUCCEEDED`, order `PAID`, and the log shows the successful Stripe calls with the event ID.

## Risks

- **`ADMIN_PASSWORD` becomes required.** The app won't start until it is in `.env`. `.env.example` gets the variable, the e2e config gets a test value, and you need to add it to your `.env` before the next `npm run start:dev`.
- **Bull Board might not mount in the e2e app.** In stage 3, `@nestjs/serve-static` silently did nothing in tests because it chose its loader before the HTTP server existed. A 404 would then look like a working login. The e2e tests therefore check that correct credentials get `200` HTML, not only that wrong ones get `401`.
- **Express 5 route matching.** Express 5 changed how wildcards work, so a middleware registered on `/admin/queues` might not cover every sub-path. The e2e tests send no credentials to the root, the root with a trailing slash, an API route and a static file, and expect `401` on each.
- **The handler's tests use a fake Stripe client.** Each fake method must now return an object with `lastResponse` (status and request ID), or the wrapper must handle its absence. The wrapper handles it (logs `status=ok`), so the existing tests keep working.
- **Bull Board 9.10.4 was published on 2026-10-05**, 11 days ago. Pinned exactly, so a later release can't change it without a deliberate upgrade.

## Task List

Tasks are tracked in `tasks/todo.md`.
