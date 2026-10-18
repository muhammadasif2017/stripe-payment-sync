# Sample Project: Stripe Payment Sync

A NestJS backend that receives Stripe payment events, processes them through a Redis job queue with retries, and keeps a PostgreSQL database in sync. It is a sample project: built against the fictional brief below to show how I would solve it, not delivered to a client.

## Client brief

A fictional brief, written the way many payment-integration job posts are written.

> **NestJS developer to sync Stripe payments into our PostgreSQL database**
>
> We sell online courses and take payments through Stripe Checkout. At the moment our backend marks an order as paid when the customer lands on our success page. If they close the tab first, the order stays unpaid and they cannot access the course. Refunds are never recorded at all, so our sales reports are wrong.
>
> We need a developer to fix this properly on our NestJS backend:
>
> - Receive Stripe webhooks for completed checkouts, failed payments and refunds, and verify that they really come from Stripe
> - Process each event only once, even when Stripe sends it twice
> - Do the processing in the background with retries, so a slow database or a Stripe outage never loses a payment
> - Give our team a page where they can see failed events and retry them
> - Run a daily check that compares Stripe with our database and fixes anything that was missed
> - Include tests, a Docker setup and a short README so our team can run it
>
> Stack: NestJS, PostgreSQL and Redis. We use Stripe test mode for development.
>
> Please tell us how you would stop a payment from being recorded twice.

## Scope and acceptance criteria

| Requirement | How it is proven |
| --- | --- |
| Stripe signature checked on every webhook | End-to-end test: a request with a wrong signature gets 400 and nothing is saved |
| Each event processed once | Unique Stripe event ID in the database; a test sends the same event twice and 1 row exists |
| Background processing with retries | BullMQ job with 5 attempts and exponential backoff; a test where the first attempt fails and the retry succeeds |
| Failed events visible and retryable | Bull Board dashboard behind a login; a failed job retried from its retry button |
| Daily reconciliation | Scheduled job compares the last 2 days of Stripe checkouts with the database; a test where a missed payment is repaired |
| Outbound Stripe calls logged | Every call logged with the event ID, endpoint, status and duration |
| Orders, payments and refunds mapped | Prisma schema with orders, payments and refunds; unit tests for the mapping functions |
| Runs with one command | Docker Compose starts the API, worker, PostgreSQL and Redis; GitHub Actions runs the tests on every push |

**Stack:** NestJS, TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Bull Board, the official Stripe Node.js library, Docker and GitHub Actions. (The brief named Jest; the project uses Vitest, which NestJS 12 ships with. See [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md), stage 1.)

**Out of scope:** a front end, Stripe live mode and real money, subscriptions and multiple currencies. A minimal checkout page is enough to trigger test payments.

## Architecture

The webhook endpoint only checks and stores the event, so it answers Stripe quickly. All the real work happens in the worker, where a failure becomes a retry instead of a lost payment. A daily reconciliation compares Stripe with the database and repairs anything missed. The diagrams are in the [README](README.md#how-it-works).

## Build plan

Built in eight stages, one pull request each. What was built and verified at each stage is in [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md).

1. **Project setup**
   - Build: a NestJS app with Prisma, plus a Docker Compose file for PostgreSQL and Redis. Load settings from environment variables and refuse to start if one is missing.
   - Done when: `docker compose up` runs and a health endpoint returns ok.
2. **Data model**
   - Build: tables for Stripe events (the Stripe event ID as primary key, type, payload, status, attempts, last error), orders, payments and refunds.
   - Done when: the migration runs, with the reason the event ID is the primary key documented.
3. **Test checkout**
   - Build: an endpoint that creates a pending order and a Stripe Checkout Session, with the order ID in the session metadata.
   - Done when: a payment with Stripe's test card 4242 4242 4242 4242 shows in the Stripe test dashboard.
4. **Webhook endpoint**
   - Build: enable `rawBody` in NestJS, verify the signature with `stripe.webhooks.constructEvent`, save the event, add a queue job using the event ID as the job ID, and return 200 straight away.
   - Done when: `stripe listen --forward-to localhost:3000/webhooks/stripe` plus `stripe trigger checkout.session.completed` saves 1 event and 1 job, and a wrong signature returns 400.
5. **Worker with retries**
   - Build: a BullMQ processor that fetches the latest object from Stripe, updates the order, payment or refund in one database transaction, and marks the event processed. 5 attempts with exponential backoff, saving the error on each failure.
   - Done when: PostgreSQL is stopped while a job runs, started again, and the job completes on a retry.
6. **Logging and dashboard**
   - Build: a wrapper around the Stripe client that logs each call with the event ID, endpoint, status and duration. Bull Board at /admin/queues behind a login.
   - Done when: a forced failure appears on the dashboard and its retry button works.
7. **Daily reconciliation**
   - Build: a scheduled job that lists completed Stripe checkouts from the last 2 days, finds any missing in the database and queues them.
   - Done when: a payment row is deleted, the job runs, and the row comes back.
8. **Tests, CI and README**
   - Build: unit tests for the mapping functions and end-to-end tests for the webhook, signing test events with `stripe.webhooks.generateTestHeaderString`. A GitHub Actions workflow with PostgreSQL and Redis services. A README with the architecture diagram, how to run the project and why it uses a queue.
   - Done when: CI is green and someone new can run the project from the README alone.
