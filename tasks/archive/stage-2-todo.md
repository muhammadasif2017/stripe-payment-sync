# Stage 2 – Data Model: Tasks

## Task 1: Test database setup

**Description:** Give the database tests their own PostgreSQL database, `payments_test`, so they can insert and delete rows freely. A Vitest global setup creates the database if it is missing and applies all migrations before the tests run.

**Acceptance criteria:**
- [x] `TEST_DATABASE_URL` in `.env.example`, pointing at `payments_test` in the existing container
- [x] The e2e Vitest config runs a global setup that creates `payments_test` if needed, runs `prisma migrate deploy` against it, and points `DATABASE_URL` at it for the tests
- [x] The setup refuses to run if `TEST_DATABASE_URL` is missing or equals `DATABASE_URL`

**Verification:**
- [x] Tests pass: `npm run test:e2e` (the existing health test now runs against `payments_test`)
- [x] Manual check: `psql \l` lists `payments_test`; rows created by tests never appear in `payments`

**Dependencies:** None

**Files likely touched:** `test/global-setup.ts`, `vitest.config.e2e.ts`, `.env.example`, `README.md`

**Estimated scope:** Small

## Task 2: StripeEvent model, first migration and duplicate-event test

**Description:** Add the `stripe_events` table, with the Stripe event ID as primary key. Create the first migration. Prove with a test that the database rejects a second event with the same ID.

**Acceptance criteria:**
- [x] `StripeEvent` model: `id` (Stripe `evt_...`, primary key), `type`, `payload` (JSON), `status` enum (`PENDING`, `PROCESSED`, `FAILED`, default `PENDING`), `attempts` (default 0), `lastError` (optional), `stripeCreatedAt`, `receivedAt` (default now), `processedAt` (optional)
- [x] Migration `init_stripe_events` applies cleanly with `npx prisma migrate dev`
- [x] Test: inserting the same event ID twice leaves 1 row and the second insert fails with Prisma error `P2002`

**Verification:**
- [x] Tests pass: `npm run test:e2e`
- [x] Manual check: temporarily remove `@id` from the event ID; the duplicate test fails. Restore it
- [x] Manual check: `\d stripe_events` in `psql` shows the primary key

**Dependencies:** Task 1

**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/*_init_stripe_events/migration.sql`, `test/stripe-event.e2e-spec.ts`

**Estimated scope:** Small

## Checkpoint: Event store
- [x] Tasks 1–2 verified
- [x] Commit

## Task 3: Order, Payment and Refund models, second migration and relationship tests

**Description:** Add `orders`, `payments` and `refunds`, linked order → payments → refunds. Each Stripe object ID is unique. Money is stored as integer cents.

**Acceptance criteria:**
- [x] `Order`: UUID `id`, `status` enum (`PENDING`, `PAID`, `PAYMENT_FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED`), `amount` (int), `currency`, `customerEmail` (optional), `stripeCheckoutSessionId` (optional, unique), timestamps
- [x] `Payment`: UUID `id`, `orderId` foreign key, `stripePaymentIntentId` (unique), `amount`, `currency`, `status` enum (`SUCCEEDED`, `FAILED`), timestamps
- [x] `Refund`: UUID `id`, `paymentId` foreign key, `stripeRefundId` (unique), `amount`, `currency`, `status` enum (`PENDING`, `SUCCEEDED`, `FAILED`, `CANCELED`), timestamps
- [x] Foreign keys use `onDelete: Restrict`; tables and columns are snake_case in PostgreSQL
- [x] Tests: create an order → payment → refund chain and read it back with relations; a duplicate `stripePaymentIntentId` fails with `P2002`; deleting an order that has a payment fails

**Verification:**
- [x] Tests pass: `npm test` and `npm run test:e2e`
- [x] Build succeeds: `npm run build`
- [x] Manual check: both migrations replay cleanly on a fresh database (`payments_replay`; Prisma blocks `migrate reset` for AI agents without user consent)

**Dependencies:** Task 2

**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/*_orders_payments_refunds/migration.sql`, `test/orders.e2e-spec.ts`

**Estimated scope:** Small to medium

## Task 4: Docs and pull request

**Description:** Record the data model and its reasons, then open the stage 2 PR.

**Acceptance criteria:**
- [x] `README.md`: how to run migrations, and the test database note
- [x] `docs/BUILD_LOG.md`: stage 2 entry
- [x] `docs/TECH_STACK.md`: Prisma migrations and PostgreSQL enums
- [x] `docs/INTERVIEW_PREP.md`: why the event ID is the primary key; why integer cents; why unique Stripe IDs make upserts safe; why `Restrict` on delete
- [x] PR from `stage-2-data-model` to `main`

**Verification:**
- [x] Manual check: a fresh clone can follow the README to a migrated database and green tests

**Dependencies:** Task 3

**Files likely touched:** `README.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md`

**Estimated scope:** Small (docs only)

## Checkpoint: Stage 2 complete
- [x] `npm test`, `npm run test:e2e`, `npm run build` and `npm run lint` all pass
- [x] Stage 2 "Done when" from `PROJECT.md` met
- [x] Commit, push, open PR
- [x] Human review and merge before stage 3 (PR #2, merged 2026-10-15)
