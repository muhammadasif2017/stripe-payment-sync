# Sample Project: Stripe Payment Sync

Oct 9, 2026 · @Muhammad Asif

A NestJS backend that receives Stripe payment events, processes them through a Redis job queue with retries, and keeps a PostgreSQL database in sync. You build it with Claude Code; it becomes the portfolio proof for Gig 3, labelled as a sample project.

## Client brief

This is a fictional brief written the way many Upwork payment-integration posts are written. Build against it as if a real client sent it, but never present it as one.

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

The project is done when every row below can be shown with a passing test or a screenshot. Together they cover every feature in Gig 3's Integration System package for 1 API, so the project backs up your top package.

| Requirement | How you prove it |
| --- | --- |
| Stripe signature checked on every webhook | End-to-end test: a request with a wrong signature gets 400 and nothing is saved |
| Each event processed once | Unique Stripe event ID in the database; test sends the same event twice and 1 row exists |
| Background processing with retries | BullMQ job with 5 attempts and exponential backoff; test where the first attempt fails and the retry succeeds |
| Failed events visible and retryable | Bull Board dashboard behind a login; screenshot of a failed job and its retry button |
| Daily reconciliation | Scheduled job compares the last 2 days of Stripe checkouts with the database; test where a missed payment is repaired |
| Outbound Stripe calls logged | Every call logged with the event ID, endpoint, status and duration; screenshot of the log |
| Orders, payments and refunds mapped | Prisma schema with orders, payments and refunds; unit tests for the mapping functions |
| Runs with one command | `docker compose up` starts the API, worker, PostgreSQL and Redis; GitHub Actions runs the tests on every push |

**Stack:** NestJS, TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Bull Board, the official Stripe Node.js library, Jest, Docker and GitHub Actions.

**Out of scope:** a front end, Stripe live mode and real money, subscriptions and multiple currencies. A minimal checkout page is enough to trigger test payments.

## Architecture

&#91;embedded content: Stripe payment sync · webhook to database, with retries and reconciliation\]

The webhook endpoint only checks and stores the event, so it answers Stripe quickly. All the real work happens in the worker, where a failure becomes a retry instead of a lost payment.

## Build plan

Build one stage at a time and commit at the end of each, so the GitHub history shows the work. Read every file Claude Code writes before moving on: a buyer or interviewer will ask why each part exists, and you need to answer without looking.

1. **Project setup**
   - Build: a NestJS app with Prisma, plus a Docker Compose file for PostgreSQL and Redis. Load settings from environment variables and refuse to start if one is missing.
   - Prompt: "Create a NestJS project with Prisma and PostgreSQL. Add docker-compose with Postgres and Redis, and a config module that validates DATABASE\_URL, REDIS\_URL, STRIPE\_SECRET\_KEY and STRIPE\_WEBHOOK\_SECRET at startup."
   - Done when: `docker compose up` runs and a health endpoint returns ok.
2. **Data model**
   - Build: tables for Stripe events (the Stripe event ID as primary key, type, payload, status, attempts, last error), orders, payments and refunds.
   - Done when: the migration runs and you can explain why the event ID is the primary key.
3. **Test checkout**
   - Build: an endpoint that creates a pending order and a Stripe Checkout Session, with the order ID in the session metadata.
   - Done when: a payment with Stripe's test card 4242 4242 4242 4242 shows in your Stripe test dashboard.
4. **Webhook endpoint**
   - Build: enable `rawBody` in NestJS, verify the signature with `stripe.webhooks.constructEvent`, save the event, add a queue job using the event ID as the job ID, and return 200 straight away.
   - Prompt: "Add a POST /webhooks/stripe endpoint. Verify the Stripe signature with the raw body, store the event once using its ID, enqueue a BullMQ job with the same ID, and respond 200 without doing the processing inline."
   - Done when: `stripe listen --forward-to localhost:3000/webhooks/stripe` plus `stripe trigger checkout.session.completed` saves 1 event and 1 job, and a wrong signature returns 400.
5. **Worker with retries**
   - Build: a BullMQ processor that fetches the latest object from Stripe, updates the order, payment or refund in one database transaction, and marks the event processed. Use 5 attempts with exponential backoff and save the error on each failure.
   - Done when: you stop PostgreSQL while a job runs, start it again, and the job completes on a retry.
6. **Logging and dashboard**
   - Build: a wrapper around the Stripe client that logs each call with the event ID, endpoint, status and duration. Mount Bull Board at /admin/queues behind a login.
   - Done when: a forced failure appears on the dashboard and its retry button works.
7. **Daily reconciliation**
   - Build: a scheduled job that lists completed Stripe checkouts from the last 2 days, finds any missing in the database and queues them.
   - Done when: you delete a payment row, run the job, and the row comes back.
8. **Tests, CI and README**
   - Build: unit tests for the mapping functions and end-to-end tests for the webhook, signing test events with `stripe.webhooks.generateTestHeaderString`. Add a GitHub Actions workflow with PostgreSQL and Redis services. Write a README with the diagram below, how to run the project and why it uses a queue.
   - Done when: CI is green and someone new can run the project from the README alone.

If you finish 1 stage a day, the project takes about 8 days. Send me the repository after any stage and I will review the code.

## Portfolio

Add it to your Fiverr profile and to Gig 3, clearly labelled as a sample project. A buyer who later learns it was not client work will not trust anything else on the page.

**Title:** Stripe Payment Sync for a NestJS Backend (sample project)

**Description:**

> Sample project built from a typical client brief, not client work. A NestJS backend that receives Stripe webhooks, verifies them and processes each event once through a Redis job queue with automatic retries. Failed events appear on a dashboard where they can be retried, and a daily check repairs any payment that was missed. It is tested end to end and runs with Docker.

**Screenshots to take** (no URLs, emails or keys visible in any of them):

- [ ] The architecture diagram from this doc, redrawn cleanly for the README
- [ ] Bull Board showing a failed job, then the same job completed after a retry
- [ ] The terminal with `stripe listen` forwarding events and your API answering 200
- [ ] Log lines for the Stripe calls, with the event ID, status and duration
- [ ] The test run, or the green GitHub Actions page

**Elsewhere:** the GitHub repository can be linked on Upwork and LinkedIn, which allow links. Once it is built, you can also add it to the Selected Engineering Projects section of your resume, because webhooks and reconciliation will then be work you have actually done.
