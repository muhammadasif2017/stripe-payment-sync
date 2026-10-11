# Stripe Payment Sync

> **Sample project.** Built from a typical client brief to show the work, not delivered to a client.

A NestJS backend that receives Stripe payment events, processes them through a Redis job queue with retries, and keeps a PostgreSQL database in sync. The full scope and build plan are in [`PROJECT.md`](PROJECT.md).

**Status:** stage 1 of 8 (project setup). The app starts, validates its configuration and reports database health. Stripe webhooks, the queue and reconciliation arrive in later stages.

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

4. Start the API.

   ```bash
   npm run start:dev
   ```

5. Check that it is healthy.

   ```bash
   curl http://localhost:3000/health
   # {"status":"ok"}
   ```

   `/health` runs `SELECT 1` against PostgreSQL. It returns 503 `{"status":"error"}` when the database is unreachable.

## Tests

```bash
npm test           # unit tests
npm run test:e2e   # end-to-end tests; needs `docker compose up -d` and a filled-in .env
npm run lint
```

The end-to-end tests use their own database, `payments_test`, set by `TEST_DATABASE_URL` in `.env`. Before the tests run, they create it if it is missing and apply every migration, so your development data in `payments` is never touched. They refuse to run if both URLs point at the same database.

## Project docs

- [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md): what was built in each stage and the problems hit along the way
- [`docs/TECH_STACK.md`](docs/TECH_STACK.md): why each technology is used
- [`docs/INTERVIEW_PREP.md`](docs/INTERVIEW_PREP.md): questions a buyer or interviewer may ask, with answers
