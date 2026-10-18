# Implementation Plan: Stage 8 – Tests, CI and Docker

## Overview

The last stage (see `PROJECT.md`, stage 8, and the README roadmap). The unit tests for the mapping functions and the webhook e2e tests signed with `generateTestHeaderString` already exist (stages 4–5). What's left:

- A **GitHub Actions** workflow that runs every check on every push and pull request, with PostgreSQL and Redis as services.
- A **Dockerfile** and Compose services, so `docker compose` starts the API, the worker, PostgreSQL and Redis, with migrations applied first.
- The **README**, so someone new can run the project from it alone.
- Items deferred from earlier stages: the `postinstall` problem from stage 1, copying `public/` into the image (stage 3), and the `npm audit` findings (stage 3).

**Done when (from `PROJECT.md`):** CI is green and someone new can run the project from the README alone.

Earlier plans and tasks are archived in `tasks/archive/`.

## CI: `.github/workflows/ci.yml`

```
on: push, pull_request
job "checks" (ubuntu-latest, Node 22)
  services: postgres:17-alpine, redis:7-alpine (health-checked)
  npm ci                      also runs `prisma generate`; no database needed
  npm run lint
  npm run typecheck
  npm test
  npm run build
  npm run test:e2e            against payments_test and Redis database 1
  npm audit --omit=dev --audit-level=high
job "docker" (needs: checks)
  docker compose --profile app up --build -d
  wait for /health = 200 on the API, then compose down
```

- **Settings come from the workflow, not `.env`.** CI has no `.env`. The workflow sets `DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `TEST_REDIS_URL`, `APP_URL` and `ADMIN_PASSWORD`. The e2e config already supplies dummy Stripe values, so CI never sees a real key and needs no secrets.
- **The database guard stays on.** CI's services listen on `localhost`, so the stage 2 "local only" guard passes without `ALLOW_REMOTE_TEST_DATABASE`.
- **Actions pinned to commit SHAs** (decision 2), with the version in a comment: `actions/checkout` (v7.0.1) and `actions/setup-node` (v7.1.0). A tag can be moved to other code; a SHA can't.
- **Least privilege:** `permissions: contents: read`, and a `concurrency` group so a new push cancels the old run.
- **The Docker smoke test** builds the image and starts the whole stack with dummy settings. It proves the image starts, connects, migrates and answers `/health`. It makes no Stripe calls.

## Docker

**`Dockerfile`, multi-stage, on `node:22.15.0-alpine`** (pinned, the same Node as development):

1. **`build`:** `npm ci` (all dependencies; `postinstall` generates the Prisma client), then `npm run build`. The generated client is compiled into `dist/generated`.
2. **`runtime`:** `npm ci --omit=dev --ignore-scripts`, then copy in `dist/`, `public/` and `prisma/` (schema and migrations). It runs as the non-root `node` user, has a `HEALTHCHECK` on `/health`, and its command is `node dist/main.js`.
   - **This fixes the stage 1 `postinstall` problem.** `--ignore-scripts` skips `prisma generate`, which fails without the dev-only Prisma CLI. The client was already generated and compiled in stage 1 of the build.
   - The runtime image is checked for `dist/generated/prisma` and `public/index.html`.
3. **`migrate`:** the build stage plus `prisma migrate deploy` as its command. The Prisma CLI is a dev dependency, so the slim runtime image doesn't carry it.

**`.dockerignore`:** `node_modules`, `dist`, `.env*` except `.env.example`, `.git`, `.claude`, `tasks`, `docs`, `test`, coverage. Secrets and local builds never enter the image.

**Compose (decision 1: an `app` profile):**

- `docker compose up -d` still starts only PostgreSQL and Redis, as today, for `npm run start:dev`.
- `docker compose --profile app up --build` also starts:
  - `migrate`: runs once, then exits.
  - `api`: `WORKER_ENABLED=false`, published on `127.0.0.1:3000`, waits for `migrate` to complete successfully.
  - `worker`: `WORKER_ENABLED=true`, no published port, same wait.
- Inside Compose, the database and Redis URLs point at the service names (`postgres:5432`, `redis:6379`), set in the Compose file. Everything else (Stripe keys, admin password, cron) comes from `.env` through `env_file`.
- `init: true`, so `SIGTERM` reaches Node and the stage 1 shutdown hooks close the database pool and BullMQ cleanly. `restart: unless-stopped` for `api` and `worker`.

## Dependencies: `npm audit`

- **Production tree:** 4 high findings, all inside the Prisma CLI's own dependencies (`deepmerge-ts` via `@prisma/config`, and `mysql2`). The CLI shows up there because `@prisma/client` lists it as an optional peer. `npm audit` reports a non-breaking fix (`fix: true`). Task 1 applies `npm audit fix` without `--force`, reviews the lockfile diff and runs every check. Anything that stays is written down with the reason.
- **CI blocks on high findings in production dependencies only.** Dev tools (`tmp` and `undici` via the Nest CLI) don't ship in the image; they're reported in the build log.

## README

- **Two ways to run, both copy-paste:** "with Docker only" (`--profile app`; needs Docker and a Stripe test key) and "for development" (today's quick start).
- A CI badge. Node 22.12+ and Docker in the requirements.
- **Why a queue,** in its own short section, as the brief asks. The content exists across "How it works"; it gets one heading.
- Check the stage 8 diagram from `PROJECT.md`'s Architecture section against the README's existing flow diagram, and add whatever is missing.
- Configuration table: the Compose-only variables.
- Roadmap: stage 8 ticked.

## Decisions for you

1. **Compose: an `app` profile? (recommended: yes)** `docker compose up -d` keeps meaning "databases for development", so the API on port 3000 never clashes with `npm run start:dev`. The full stack is `docker compose --profile app up --build`: one line in the README. The alternative is starting everything by default, with development using `docker compose up -d postgres redis`.
2. **Pin GitHub Actions to commit SHAs? (recommended: yes)** This protects against a moved tag. The cost is updating the SHA by hand when upgrading.
3. **Rate-limit dashboard logins? (recommended: yes)** At most 10 failed Basic auth attempts per 15 minutes per IP, then 429. It's small (`express-rate-limit`, one middleware, tests) and was promised for this stage. HTTPS stays a README note: the stack only listens on `127.0.0.1`, and a production proxy depends on where it's deployed.
4. **Your repository is private.** GitHub Actions works there (free minutes apply). The CI badge only shows to people with access. Publishing it as a portfolio piece needs the repository public eventually. That's your call, and nothing in this stage depends on it.

## The "Done when" check

1. **CI:** both jobs green on the stage 8 pull request.
2. **"Someone new":** a fresh `git clone` into a scratch folder, following only the README's Docker section.
   - Its `.env` gets the Stripe test key, the webhook secret and a new admin password. Ports are changed if the development containers are using them, as the README's tip explains.
   - Then: `/health` is 200, the dashboard asks for a login, a test payment with card 4242 ends `PAID` (with `stripe listen` forwarding to the containerised API), and the worker container's log shows the Stripe calls.
   - Afterwards: `docker compose --profile app down -v` in the clone, and the scratch folder is deleted. Your development containers and data aren't touched.

## Risks

- **Prisma in the slim image.** Whether `npm ci --omit=dev` pulls in the Prisma CLI as an optional peer is checked in the built image, not assumed. Either way, the runtime only needs `@prisma/client` and the compiled client.
- **Windows line endings.** `.gitattributes` exists. Shell scripts used in the image must be LF; the plan uses none (the Dockerfile `CMD` and the Compose commands only).
- **CI timing.** Unit and e2e tests take about 40 seconds locally. The image build adds a few minutes, cached by `npm ci` layers.
- **The worker container calls Stripe with the key from `.env`.** That includes the daily reconciliation. Test mode only, as everywhere in this project.

## Task List

Tasks are tracked in `tasks/todo.md`.
