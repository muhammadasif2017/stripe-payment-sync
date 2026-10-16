# Stripe Payment Sync

> **Sample project.** Built from a typical client brief to show the work, not delivered to a client.

A NestJS backend that receives Stripe payment events, processes them through a Redis job queue with retries, and keeps a PostgreSQL database in sync. The full scope and build plan are in [`PROJECT.md`](PROJECT.md).

**Status:** stage 5 of 8 (worker with retries). A minimal checkout page creates an order and sends the customer to Stripe's test-mode payment page. `POST /webhooks/stripe` verifies, stores and queues each Stripe event; a BullMQ worker fetches the latest payment, session or refunds from Stripe and updates the order, payment and refunds in one transaction, retrying up to 5 times with exponential backoff. Orders become `PAID`, `PAYMENT_FAILED`, `EXPIRED`, `PARTIALLY_REFUNDED` or `REFUNDED` from Stripe's events, never from the success page.

## Data model

| Table | Holds | Key point |
|---|---|---|
| `stripe_events` | Every webhook event Stripe sends, as received | The Stripe event ID is the primary key, so a duplicate delivery is rejected by the database |
| `orders` | A customer's purchase of a course | Course and amount (in cents) come from the server's catalog; `PENDING` until Stripe confirms payment |
| `payments` | Each payment attempt for an order | Unique Stripe payment intent ID |
| `refunds` | Full or partial refunds of a payment | Unique Stripe refund ID |

Orders link to payments and payments to refunds. A payment or refund cannot be orphaned: deleting an order that has payments is refused. The schema is in [`prisma/schema.prisma`](prisma/schema.prisma), with a comment on each decision.

## Requirements

- Node.js 22.12 or newer
- Docker Desktop (running)

## Run it locally

1. Install dependencies. This also generates the Prisma client.

   ```bash
   npm install
   ```

2. Create your `.env` from the example and fill in the Stripe test keys.

   ```bash
   cp .env.example .env
   ```

   The app refuses to start if a variable is missing, and it only accepts Stripe test-mode keys (`sk_test_...`).

3. Start PostgreSQL and Redis.

   ```bash
   docker compose up -d
   ```

   They listen on `localhost:5435` and `localhost:6380`, so they don't clash with other local databases. Change `POSTGRES_PORT` and `REDIS_PORT` in `.env` if those ports are taken too, and update `DATABASE_URL` and `REDIS_URL` to match.

4. Create the database tables.

   ```bash
   npx prisma migrate deploy
   ```

   After you change `prisma/schema.prisma`, create a new migration with `npm run db:migrate`. It runs `prisma migrate dev` and then `prisma generate`, because Prisma 7 no longer regenerates the client after a migration.

5. Start the API.

   ```bash
   npm run start:dev
   ```

6. Check that it is healthy.

   ```bash
   curl http://localhost:3000/health
   # {"status":"ok"}
   ```

   `/health` runs `SELECT 1` against PostgreSQL. It returns 503 `{"status":"error"}` when the database is unreachable.

## Make a test payment

1. Put your Stripe **test** secret key in `.env` as `STRIPE_SECRET_KEY` (Stripe Dashboard, test mode, Developers → API keys). `APP_URL` must be the address you open in the browser, `http://localhost:3000` by default.
2. Start the API (`npm run start:dev`) and open <http://localhost:3000>.
3. Choose a course and click **Buy**. The API saves a `PENDING` order, creates a Stripe Checkout Session with the order ID in its metadata, and redirects you to Stripe.
4. Pay with card `4242 4242 4242 4242`, any future expiry date, any CVC and any postcode.
5. Stripe sends you back to `/success.html`. The payment appears under Payments in the Stripe test dashboard, with `order_id` in its metadata.

The order stays `PENDING` in the database. That is deliberate: the success page never marks an order paid, because a customer can close the tab before reaching it. Stripe's webhook will do that from stage 4.

The API behind the page:

```bash
curl http://localhost:3000/checkout/courses
curl -X POST http://localhost:3000/checkout   -H 'Content-Type: application/json'   -d '{"courseId":"nestjs-fundamentals","email":"buyer@example.com"}'
# 201 {"orderId":"...","checkoutUrl":"https://checkout.stripe.com/..."}
```

Only `courseId` and an optional `email` are accepted; the price comes from the server. Any other field, such as `amount`, gets a 400.

## Receive Stripe webhooks locally

Needs the [Stripe CLI](https://docs.stripe.com/stripe-cli). Run every CLI command with your **test** key, so the CLI can't touch live mode even if your login defaults to it. In Git Bash:

```bash
export STRIPE_API_KEY=$(grep '^STRIPE_SECRET_KEY=' .env | cut -d= -f2-)
```

In PowerShell: `$env:STRIPE_API_KEY = (Select-String '^STRIPE_SECRET_KEY=(.*)' .env).Matches.Groups[1].Value`.

1. Put the webhook signing secret in `.env` as `STRIPE_WEBHOOK_SECRET`. Print it with `stripe listen --print-secret`; it stays the same for this machine.
2. Start the API (`npm run start:dev`).
3. Forward events to it:

   ```bash
   stripe listen --all-snapshot --latest --forward-to localhost:3000/webhooks/stripe
   ```

4. In another terminal, fire a test payment's events, or buy a course on the checkout page:

   ```bash
   stripe trigger checkout.session.completed
   ```

The worker runs inside the API process by default and updates the order a moment after the event arrives. To run them as separate processes, start the API with `WORKER_ENABLED=false` and a second copy with `WORKER_ENABLED=true` and another `PORT`. Failed attempts are retried after 10, 20, 40 and 80 seconds; each failure is saved on the event (`attempts`, `last_error`), and after the 5th, or at once for an error a retry can't fix (such as an event with no matching order), the event is marked `FAILED`.

Every event gets 200. Only the types the system handles (`checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `refund.updated`) are stored in `stripe_events` and queued, once each, with the Stripe event ID as both the row ID and the job ID. A request with a missing or wrong signature gets 400 and nothing is saved.

## Tests

```bash
npm test           # unit tests
npm run test:e2e   # end-to-end tests; needs `docker compose up -d` and a filled-in .env (Stripe is faked, no key needed)
npm run lint
npm run typecheck  # type-checks src/ and test/; Vitest and the build skip test files
```

The end-to-end tests use their own database, `payments_test`, set by `TEST_DATABASE_URL` in `.env`, and their own Redis database, `TEST_REDIS_URL` (database 1). They sign their own webhook payloads with a fixed test secret. Before the tests run, they create it if it is missing and apply every migration, so your development data in `payments` is never touched. They refuse to run if both URLs reach the same database (same host, port and name), or if the test database is not on this machine. For a throwaway database elsewhere, such as a CI service, set `ALLOW_REMOTE_TEST_DATABASE=true`.

## Project docs

- [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md): what was built in each stage and the problems hit along the way
- [`docs/TECH_STACK.md`](docs/TECH_STACK.md): why each technology is used
- [`docs/INTERVIEW_PREP.md`](docs/INTERVIEW_PREP.md): questions a buyer or interviewer may ask, with answers
