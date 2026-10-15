# Stage 4 – Webhook Endpoint: Tasks

## Task 1: BullMQ queue and test Redis

**Description:** Connect to Redis and register the `stripe-events` queue with its retry settings. Give the e2e tests their own Redis database.

**Acceptance criteria:**
- [x] `bullmq@6.3.10`, `@nestjs/bullmq@12.0.0` and `ioredis` installed with exact versions
- [x] `QueueModule` registers the `stripe-events` queue from `REDIS_URL`: 5 attempts, exponential backoff, completed jobs kept 7 days, failed jobs kept
- [x] `TEST_REDIS_URL` in `.env.example` (database 1); the e2e config points `REDIS_URL` at it and refuses the same database as `REDIS_URL`
- [x] A shared `test/create-test-app.ts` builds the app the way `main.ts` does (raw body, checkout pages), so e2e tests can't drift from it

**Verification:**
- [x] e2e: adding two jobs with the same job ID leaves 1 job; the queue's default options are the ones above
- [x] Unit tests for the Redis test-URL guard
- [x] All five checks pass

**Dependencies:** None

**Files likely touched:** `package.json`, `src/queue/queue.module.ts`, `src/app.module.ts`, `vitest.config.e2e.ts`, `test/test-redis.ts`, `test/create-test-app.ts`, `.env.example`

**Estimated scope:** Medium

## Task 2: Webhook endpoint with signature check

**Description:** `POST /webhooks/stripe` verifies the `Stripe-Signature` header against the raw body with `STRIPE_WEBHOOK_SECRET`.

**Acceptance criteria:**
- [ ] `rawBody: true` in `main.ts` and in the test app
- [ ] Missing header, wrong signature, wrong secret, old timestamp or a tampered body: 400, nothing saved, no job
- [ ] Live-mode event: 400, nothing saved
- [ ] The cause is logged; the response says only that the signature is invalid

**Verification:**
- [ ] e2e tests with payloads signed by `generateTestHeaderString`
- [ ] Prove a test can fail (e.g. skip the check)

**Dependencies:** Task 1

**Files likely touched:** `src/webhooks/webhooks.module.ts`, `webhooks.controller.ts`, `src/main.ts`, `test/webhooks.e2e-spec.ts`

**Estimated scope:** Small to medium

## Checkpoint: Queue and signature
- [ ] Tasks 1–2 verified, all five checks pass, commit

## Task 3: Store the event and enqueue it

**Description:** After the signature check, save the event and add one job, then answer 200.

**Acceptance criteria:**
- [ ] Handled types (decision 1) are stored with `id`, `type`, `payload`, `stripeCreatedAt`, status `PENDING`; other types get 200 and are not stored
- [ ] Job `{ eventId }` with `jobId = event.id`
- [ ] A duplicate delivery returns 200 and leaves 1 row and 1 job
- [ ] If the insert or the enqueue fails: 500 (Stripe retries); a retry after a failed enqueue adds the job

**Verification:**
- [ ] e2e: valid event gives 1 row + 1 job; same event twice gives 1 + 1; unhandled type gives 0 + 0; enqueue failure gives 500 and a later redelivery gives 1 + 1
- [ ] Unit tests for the service's duplicate and failure paths
- [ ] Prove a test can fail (e.g. drop the job ID)

**Dependencies:** Task 2

**Files likely touched:** `src/webhooks/webhooks.service.ts`, `src/webhooks/handled-events.ts`, tests

**Estimated scope:** Medium

## Checkpoint: Endpoint complete
- [ ] Tasks 1–3 verified, all five checks pass, commit

## Task 4: Real Stripe check, docs and pull request

**Description:** Run the "Done when" with the Stripe CLI in test mode, record it, open the PR.

**Acceptance criteria:**
- [ ] `STRIPE_WEBHOOK_SECRET` in `.env` set from `stripe listen --print-secret` (test key, value never printed)
- [ ] `stripe listen --forward-to localhost:3000/webhooks/stripe` + `stripe trigger checkout.session.completed`: 1 `checkout.session.completed` row, 1 job with the same ID
- [ ] A request with a wrong signature returns 400
- [ ] A real checkout from stage 3 paid with card 4242 also arrives as an event
- [ ] `README.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md` (BullMQ, Redis, raw body), `docs/INTERVIEW_PREP.md` (why raw body, why answer fast, why job ID = event ID, what happens when each step fails)
- [ ] PR from `stage-4-webhook-endpoint` to `main`

**Verification:**
- [ ] Manual check with the Stripe CLI, database query and queue count

**Dependencies:** Task 3

**Files likely touched:** `README.md`, `docs/*.md`

**Estimated scope:** Small

## Checkpoint: Stage 4 complete
- [ ] All five checks pass
- [ ] Stage 4 "Done when" from `PROJECT.md` met
- [ ] Commit, push, open PR
- [ ] Human review and merge before stage 5
