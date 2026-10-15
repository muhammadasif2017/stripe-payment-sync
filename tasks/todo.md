# Stage 3 – Test Checkout: Tasks

## Task 1: Stripe client and settings

**Description:** Install the official Stripe library and provide one configured client to the rest of the app. Add the `APP_URL` setting.

**Acceptance criteria:**
- [x] `stripe@23.0.0` installed with an exact version
- [x] `StripeModule` (global) provides the client under an injection token, built from `STRIPE_SECRET_KEY` via `ConfigService<Env, true>`
- [x] `APP_URL` validated in `src/config/env.validation.ts` (http/https URL) and added to `.env.example`

**Verification:**
- [x] Unit tests: the provider builds a client from the configured key; env validation rejects a missing or invalid `APP_URL`
- [x] `npm run typecheck`, `npm test`

**Dependencies:** None

**Files likely touched:** `package.json`, `src/stripe/stripe.module.ts`, `src/config/env.validation.ts`, `.env.example`, `src/app.module.ts`

**Estimated scope:** Small

## Task 2: Course catalog and `course_id` on orders

**Description:** A small catalog in code (course ID → name, amount in cents, currency). Store the course ID on each order.

**Acceptance criteria:**
- [x] `src/checkout/catalog.ts` with two test courses and a lookup that returns `undefined` for an unknown ID
- [x] Migration `order_course_id` adds `course_id` (text, required) to `orders`

**Verification:**
- [x] Unit tests for the lookup
- [x] `npm run test:e2e`: existing order tests updated and passing

**Dependencies:** None (needs decision 1)

**Files likely touched:** `src/checkout/catalog.ts`, `prisma/schema.prisma`, `prisma/migrations/*_order_course_id/`, `test/orders.e2e-spec.ts`

**Estimated scope:** Small

## Checkpoint: Foundations
- [x] Tasks 1–2 verified, all five checks pass, commit

## Task 3: Checkout endpoint

**Description:** `POST /checkout` with `{ courseId, email? }`. Creates a `PENDING` order, then a Checkout Session, saves the session ID on the order and returns `201 { orderId, checkoutUrl }`.

**Acceptance criteria:**
- [x] Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`); DTO validated with `class-validator`
- [x] Session: `mode: 'payment'`, inline `price_data` from the catalog, `metadata.order_id`, `payment_intent_data.metadata.order_id`, `client_reference_id`, `customer_email` when given, success URL with `{CHECKOUT_SESSION_ID}`, cancel URL, idempotency key = order ID
- [x] Unknown course or extra fields such as `amount`: 400, no order created
- [x] Stripe error: 502 with a generic message, cause logged, order stays `PENDING` without a session ID

**Verification:**
- [x] Unit tests with a fake Stripe client: exact session parameters and idempotency key
- [x] e2e tests with the Stripe provider replaced: order row saved with the session ID and course; 400 cases leave no row; 502 case leaves a `PENDING` order without session ID and no Stripe error text in the response
- [x] Prove the tests can fail (e.g. drop the metadata or the idempotency key)

**Dependencies:** Tasks 1, 2

**Files likely touched:** `src/checkout/checkout.module.ts`, `checkout.controller.ts`, `checkout.service.ts`, `dto/create-checkout.dto.ts`, `src/main.ts`, `test/checkout.e2e-spec.ts`

**Estimated scope:** Medium

## Task 4: Minimal checkout pages

**Description:** `public/index.html` lists the courses with a "Buy" button that calls `POST /checkout` and redirects to Stripe. `success.html` says the payment is being confirmed; `cancel.html` offers to try again. Neither page changes the database.

**Acceptance criteria:**
- [x] Pages served from `public/` by NestJS
- [x] Success page makes no API call that changes the order

**Verification:**
- [x] e2e: `GET /` and `GET /success.html` return 200 HTML; the order stays `PENDING` after loading the success page

**Dependencies:** Task 3 (needs decision 2)

**Files likely touched:** `public/*.html`, `src/main.ts`, `test/checkout.e2e-spec.ts`

**Estimated scope:** Small

## Checkpoint: Endpoint and pages
- [x] Tasks 3–4 verified, all five checks pass, commit

## Task 5: Real test payment, docs and pull request

**Description:** With your real test key in `.env`, pay with the 4242 card and check the Stripe test dashboard. Record the stage in the docs and open the PR.

**Acceptance criteria:**
- [x] Payment with 4242 4242 4242 4242 shows as succeeded in the Stripe test dashboard, with `order_id` in its metadata (screenshot for the portfolio)
- [x] The order is still `PENDING` in the database (the webhook in stage 4 will change it)
- [x] `README.md`: status stage 3, how to make a test payment
- [x] `docs/BUILD_LOG.md`, `docs/TECH_STACK.md` (Stripe library, class-validator), `docs/INTERVIEW_PREP.md` (why the server sets the price, why the success page doesn't mark orders paid, why the idempotency key, why order ID is in two metadata places)
- [x] PR from `stage-3-test-checkout` to `main`

**Verification:**
- [x] Manual check in the browser and the Stripe dashboard

**Dependencies:** Tasks 3–4; your real test key

**Files likely touched:** `README.md`, `docs/*.md`

**Estimated scope:** Small

## Checkpoint: Stage 3 complete
- [x] All five checks pass
- [x] Stage 3 "Done when" from `PROJECT.md` met
- [x] Commit, push, open PR
- [ ] Human review and merge before stage 4
