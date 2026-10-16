# Implementation Plan: Stage 4 – Webhook Endpoint

## Overview

Stage 4 receives Stripe's webhooks (see `PROJECT.md`, stage 4). `POST /webhooks/stripe` checks the Stripe signature against the raw request body, stores the event once in `stripe_events`, adds a BullMQ job whose job ID is the event ID, and answers 200 straight away. No processing happens in the request: the worker that updates orders, payments and refunds is stage 5, so jobs wait in the queue until then.

**Done when (from `PROJECT.md`):** `stripe listen --forward-to localhost:3000/webhooks/stripe` plus `stripe trigger checkout.session.completed` saves 1 event and 1 job, and a wrong signature returns 400.

Stage 1–3 plans and tasks are archived in `tasks/archive/`.

## Flow

```
Stripe ──POST /webhooks/stripe──> verify signature (raw body + STRIPE_WEBHOOK_SECRET)
                                     │ bad / missing ──> 400, nothing saved
                                     │ live-mode event ──> 400, nothing saved
                                     │ type not handled ──> 200, nothing saved
                                     v
                                  INSERT stripe_events (id = evt_...)
                                     │ already there (P2002) ──> fine, continue
                                     v
                                  queue.add('stripe-events', { eventId }, { jobId: eventId })
                                     v
                                  200 { received: true }
```

## Architecture Decisions

- **The signature is checked on the raw body.** Stripe signs the exact bytes it sent. If NestJS parses the JSON first and the code re-serialises it, spacing or key order can differ and every signature fails. NestJS's `rawBody: true` option keeps the original bytes next to the parsed body. `constructEvent` also rejects signatures older than 5 minutes, which stops replayed requests.
- **Store first, then enqueue, then answer 200.** The webhook only records the event; the worker does the work. Stripe gets its answer in milliseconds, and a slow database or Stripe API in stage 5 becomes a retry instead of a webhook timeout.
- **Duplicates are handled twice over.** The event ID is the primary key, so a second delivery can't insert a second row (`P2002`, treated as success). The job ID is the event ID, so BullMQ ignores a second `add` while the job exists.
- **Every failure before the 200 makes Stripe retry.** If the insert or the enqueue fails, the endpoint answers 500 and Stripe redelivers later (for up to 3 days). On redelivery the row already exists, the insert is skipped, and the enqueue runs again. Nothing is lost between the two writes.
- **Only event types the worker handles are stored** (see decision 1). Others get 200 and are dropped, so Stripe stops sending them.
- **Live-mode events are refused (400).** The project is test mode only, like the `sk_test_` check at startup.
- **Queue settings are set now, because jobs are created now:** 5 attempts with exponential backoff (the stage 5 requirement), completed jobs kept for 7 days so a late duplicate still finds its job ID, failed jobs kept for the dashboard in stage 6.
- **BullMQ 6.3.10 and `@nestjs/bullmq` 12.0.0**, pinned. BullMQ 6 no longer bundles a Redis client, so `ioredis` is installed too. Code is written from the installed types, not from memory of BullMQ 5.
- **Tests use their own Redis database** (`TEST_REDIS_URL`, database 1 in the same container), with the same guard as the test PostgreSQL database. Tests sign their own payloads with `stripe.webhooks.generateTestHeaderString`, so they need no network and no Stripe CLI.
- **The Stripe CLI always runs with the test key from `.env`** (`STRIPE_API_KEY`). Your CLI login defaults to live mode, and nothing here may touch live mode. The webhook secret printed by `stripe listen` goes into `.env` without being shown in the chat.

## Decision for you

1. **Store only handled event types? (recommended: yes)** The allowlist: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `refund.updated`. These are the events that change an order, payment or refund. The alternative is to store every event as an audit log; then `stripe trigger checkout.session.completed` saves about 6 events (product, price, payment intent, charge...), not the 1 the "Done when" expects.

## Risks

- **BullMQ 6 is a new major version** (July 2026). If its NestJS integration misbehaves, fall back to BullMQ 5 (the last 5.x is mature and supported by `@nestjs/bullmq` 12).
- **Jobs pile up until stage 5.** Expected; they are processed when the worker exists.
- **`STRIPE_WEBHOOK_SECRET` from `stripe listen` is per CLI session.** It stays the same between runs on the same machine, but a deployed endpoint has a different secret from the Stripe dashboard.

## Task List

Tasks are tracked in `tasks/todo.md`.
