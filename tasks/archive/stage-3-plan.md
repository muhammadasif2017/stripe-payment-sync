# Implementation Plan: Stage 3 – Test Checkout

## Overview

Stage 3 lets a customer start a payment (see `PROJECT.md`, stage 3). An endpoint creates a `PENDING` order in PostgreSQL, then a Stripe Checkout Session in test mode with the order ID in its metadata, and returns the Stripe payment page URL. A minimal HTML page with a "Buy" button calls it, so a test payment can be made in the browser.

**Done when (from `PROJECT.md`):** a payment with Stripe's test card 4242 4242 4242 4242 shows in the Stripe test dashboard.

Nothing here marks an order as paid. That is the client's original bug: their backend trusts the success page, which the customer may never reach. In this project, only Stripe's webhook (stage 4) and the worker (stage 5) change an order's status.

Stage 1 and 2 plans and tasks are archived in `tasks/archive/`.

## Flow

```
Browser                     API                          PostgreSQL         Stripe
  | POST /checkout {courseId} |                               |                 |
  |-------------------------->| insert order (PENDING)  ----->|                 |
  |                           | create Checkout Session ------------------------>|
  |                           |   metadata.order_id, idempotency key = order id  |
  |                           | save session id on order ---->|                 |
  |<-- 201 {orderId, url} ----|                               |                 |
  | redirect to url, pay with 4242 card ------------------------------------- -->|
  |<-- Stripe redirects to /success.html (shows "processing", changes nothing)   |
```

## Architecture Decisions

- **The server decides the price.** The request carries only a course ID and an optional email. Name, amount and currency come from a small course catalog in code. A client that sends `amount` is rejected (400), so nobody can buy a course for 1 cent by editing the request.
- **The order is created before the Checkout Session.** The session needs the order ID in its metadata, so the order must exist first. A database row and a Stripe call can't share a transaction. If Stripe fails, the order stays `PENDING` with no session ID, the client gets a generic 502, and the cause is logged. No money moved, and the row shows the attempt happened.
- **Idempotency key = order ID.** If the request to Stripe is retried (by the SDK on a network error), Stripe returns the same session instead of creating a second one.
- **The order ID is in two places: `metadata.order_id` on the session and `payment_intent_data.metadata.order_id`.** Session metadata is not copied to the PaymentIntent. Stage 5 handles `payment_intent.payment_failed`, whose object is a PaymentIntent, so it needs the order ID there too. `client_reference_id` also carries it, which makes it visible in the Stripe dashboard. (Confirm against Stripe's docs while building.)
- **Inline `price_data` instead of Products created in the dashboard.** Nothing to set up by hand in Stripe, and the catalog stays in the repository.
- **Official `stripe` library, pinned to 23.0.0** (latest stable, released 2026-10-01). The client is one NestJS provider built from `STRIPE_SECRET_KEY` through `ConfigService`, so tests can replace it. The logging wrapper is stage 6.
- **Request validation with `class-validator` and a global `ValidationPipe`** (`whitelist`, `forbidNonWhitelisted`). It is NestJS's standard way to validate request bodies; unknown fields fail with 400.
- **New setting `APP_URL`** (e.g. `http://localhost:3000`) builds the success and cancel URLs. Validated at startup like the others.
- **Tests never call Stripe.** Unit tests use a fake client, and e2e tests replace the Stripe provider. CI in stage 8 then needs no Stripe secret. The real payment with the test card is a manual check in the browser.
- **Static pages from `public/`** (`index.html`, `success.html`, `cancel.html`) served by NestJS. No front-end framework (out of scope).

## Decisions for you

1. **Store the course on the order? (recommended: yes)** Add a `course_id` column to `orders` (migration `order_course_id`). Without it the database knows an amount was paid but not for what, so the client couldn't grant course access or report sales per course. The catalog in code maps `course_id` to name and price.
2. **Minimal HTML page? (recommended: yes)** A one-button page makes the manual test card payment easy and gives a portfolio screenshot. The alternative is calling the endpoint with `curl` and opening the returned URL by hand.

## Prerequisite (your action)

`STRIPE_SECRET_KEY` in `.env` is a placeholder (18 characters; real test keys are much longer). Before task 5, copy your test secret key from the Stripe dashboard (Developers → API keys, test mode) into `.env` yourself. Don't paste it in the chat. The webhook secret and the Stripe CLI are needed only in stage 4.

## Risks

- **Stripe 23 is a new major version.** Code is written from the installed type definitions and Stripe's docs, not from memory of older versions.
- **Orders with no session pile up if Stripe is down.** Acceptable for now: they hold no money. Stage 7 (reconciliation) or a cleanup job could expire them.
- **`price_data` amounts live in code.** Changing a price needs a deploy. Fine for a sample with one or two courses.

## Task List

Tasks are tracked in `tasks/todo.md`.
