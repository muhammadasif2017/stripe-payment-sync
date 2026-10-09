# Implementation Plan: Stage 1 – Project Setup

## Overview

Stage 1 lays the foundation for Stripe Payment Sync (see `PROJECT.md`). It produces a NestJS app that loads its settings from environment variables and refuses to start if one is missing. It talks to PostgreSQL through Prisma, and it runs against PostgreSQL and Redis started by Docker Compose. The stage is done when `docker compose up` brings up the databases and `GET /health` returns ok.

No business tables, Stripe calls or queues are built here. Those start in stage 2.

## Architecture Decisions

- **Vitest instead of Jest.** NestJS 12 scaffolds Vitest by default; `PROJECT.md` lists Jest. Kept Vitest: same `describe`/`it`/`expect` API, faster, and no fight with the framework's ESM setup.
- **Ports 5435 and 6380 on the host.** The job-tracker project already uses 5432 and 6379. Both are bound to 127.0.0.1 only.
- **npm as package manager.** It ships with Node 22, so there is nothing extra to install or explain.
- **Docker Compose runs only PostgreSQL and Redis in stage 1.** The API runs on the host with `npm run start:dev` for fast reloads. The API and worker containers are added later, before the final "runs with one command" check in stage 8.
- **Config validation with `@nestjs/config` and a schema.** The schema validates `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` at startup. A missing value stops the app before it serves any request, which is easier to debug than a crash at the first Stripe call.
- **Prisma wrapped in a `PrismaService`.** One shared client, connected when the module starts and closed on shutdown. Check the current Prisma major version's setup in the official docs before writing it, because recent versions changed the generator and config files.
- **Health endpoint pings the database.** `GET /health` runs `SELECT 1` through Prisma. It returns 200 when the database answers and 503 when it does not, so it proves the Prisma wiring and not only that the server is up. A Redis check joins it in stage 4, when the app first connects to Redis.
- **Secrets never committed.** `.env` is git-ignored. `.env.example` lists every variable with placeholder values.

## Task List

Tasks are tracked in `tasks/todo.md`.

### Phase 1: Running skeleton
- [x] Task 1: Scaffold the NestJS app
- [x] Task 2: Docker Compose for PostgreSQL and Redis
- [x] Task 3: Validated config module

### Checkpoint: Skeleton
- [x] App starts with a full `.env` and stops with a clear error when a variable is missing
- [x] Containers report healthy

### Phase 2: Database and health
- [x] Task 4: Prisma setup and `PrismaService`
- [x] Task 5: Health endpoint
- [x] Task 6: Docs and stage 1 commit

### Checkpoint: Stage 1 complete
- [x] `docker compose up -d`, then `npm run start:dev`, then `GET /health` returns 200 `{ "status": "ok" }`
- [x] All tests pass and `npm run build` succeeds
- [ ] Human review before stage 2

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Stripe CLI not installed | Low now, high at stage 4 | Install before stage 4 (`winget install Stripe.StripeCLI` or `scoop install stripe`) |
| A local PostgreSQL or Redis already uses port 5432 or 6379 | Medium | Map host ports through `.env` (e.g. `POSTGRES_PORT`) so a clash is a one-line change |
| Docker Desktop not running | Low | Compose fails fast with a clear error; start Docker Desktop first |
| Prisma setup changed between major versions | Medium | Follow the official Prisma + NestJS guide for the installed version, not memory |
| Windows CRLF line endings break shell scripts in containers | Low | Add `.gitattributes` with `* text=auto eol=lf` in Task 1 |

## Open Questions

- None blocking. The API and worker containers are deferred to a later stage; say so now if you want them in stage 1 instead.
