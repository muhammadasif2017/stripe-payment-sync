# Stripe Payment Sync

NestJS backend that receives Stripe webhooks, processes them through a BullMQ queue with retries, and keeps PostgreSQL in sync. Sample portfolio project, built in 8 stages.

- Scope, acceptance criteria and stage plan: `PROJECT.md` (read the current stage's section, not the whole file)
- Current stage plan and tasks: `tasks/plan.md`, `tasks/todo.md`; finished stages in `tasks/archive/`
- Why each decision was made: `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md`

## Stack

NestJS 12 (ES modules), TypeScript strict, Prisma 7.10.0 with `@prisma/adapter-pg`, PostgreSQL 17, Redis 7, Vitest, oxlint, Docker Compose. Node 22.

## Commands

- Start databases: `docker compose up -d` (PostgreSQL on 5435, Redis on 6380, both 127.0.0.1 only)
- Dev server: `npm run start:dev` (API and worker; `WORKER_ENABLED=false` for API only)
- Queue dashboard: `http://localhost:3000/admin/queues`, Basic auth with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`
- Reconciliation: runs daily (`RECONCILIATION_CRON`, UTC) in the worker; start one by hand with **Schedulers > Run now** on the dashboard. Change the schedule in the setting, not on the dashboard: every worker start re-registers it.
- Unit tests: `npm test`
- e2e tests: `npm run test:e2e` (needs the databases; runs against `payments_test`)
- Lint / types / build: `npm run lint`, `npm run typecheck`, `npm run build`
- New migration after a schema change: `npm run db:migrate` (Prisma 7 does not regenerate the client on its own)

Run all five checks (unit, e2e, lint, typecheck, build) before every commit. A hook (`.claude/hooks/commit-guard.mjs`, set up in `.claude/settings.json`) blocks `git commit` when lint, typecheck or unit tests fail, when the message mentions the assistant, or when a `.env` file is included. Run e2e and build yourself.

## Code conventions

- Relative imports end in `.js` (`./prisma.service.js`), including `supertest/types.js`: `nodenext` ESM requires it.
- Read settings through `ConfigService<Env, true>`, never `process.env`. New variables go in `src/config/env.validation.ts` and `.env.example`.
- JSDoc on every exported function, class and method. Inline comments explain why, not what.
- Prisma client is generated to `src/generated/prisma` (git-ignored); import from `../generated/prisma/client.js`.
- Schema: camelCase in TypeScript, snake_case in PostgreSQL via `@map`/`@@map`. Money is `Int` in cents. Timestamps are `@db.Timestamptz(3)`. Every Stripe ID column is `@unique`. Foreign keys use `onDelete: Restrict`.
- CHECK constraints cannot be expressed in `schema.prisma`; add them in a hand-written migration (`prisma migrate dev --create-only`).
- Errors returned to clients never include internal details; log the cause server-side.
- Every Stripe call goes through `StripeCalls.run(endpoint, context, call)` (`src/stripe/stripe-calls.ts`) so it is logged. Never log Stripe parameters or bodies.

## Tests

- Database tests use `createTestPrisma()` from `test/test-prisma.ts` and clean up only the rows they created, using IDs unique per run.
- Each test must pass when run alone.
- Prove a new test can fail: break the code or the constraint (in `payments_test` only), watch it fail, restore it.

## Workflow

- One branch and one PR per stage (`stage-N-short-name`). Plan first in `tasks/`, get approval, then build task by task with a commit per task. The user reviews and merges; never merge without being asked.
- Commit messages: one short line, no body, and never mention Claude, Claude Code or Anthropic (no attribution or co-author lines).
- After each task, update `docs/BUILD_LOG.md`, `docs/TECH_STACK.md` and `docs/INTERVIEW_PREP.md` in plain language; the user is preparing for interviews about this code.

## Boundaries

- Stripe test mode only. Never commit `.env` or any real key.
- The Stripe CLI login defaults to live mode. Run every `stripe` command with `STRIPE_API_KEY` set to the test key from `.env`, never with `--live`, and never print key or webhook secret values.
- Never run `prisma migrate reset` or drop tables on the `payments` database without the user's explicit consent.
- Ports 5432 and 6379 belong to another project's containers; don't stop or change them.
- Out of scope (from `PROJECT.md`): front end beyond a minimal checkout page, live mode, subscriptions, multiple currencies.

## Gotchas

- Windows PowerShell 5.1 drops empty arguments: `gh pr merge --body ""` fails. Pass real text.
- `stripe listen` needs `--all-snapshot` (or `--events`), and `--latest` so events use the API version the code targets.
- The Stripe CLI is installed with winget; a shell started before the install may not have it on its PATH. Call it by full path: `$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Stripe.StripeCli_Microsoft.Winget.Source_8wekyb3d8bbwe\stripe.exe`.
- Prettier has no `printWidth` in `.prettierrc`; format changed files with `npx prettier --print-width 100 --write <files>` to match the code, never the whole project.
- Bull Board's retry button asks "Are you sure?" before it retries.
- BullMQ custom job IDs can't be integers or contain `:`; use `-` as separator.
- e2e files that load `WorkerModule` register the reconciliation scheduler on the test Redis; remove it (`removeJobScheduler`) and obliterate the `reconciliation` queue in `afterAll`.
- npm's `latest` tag for Prisma points at an 8.x release candidate; stay on 7.10.0.
- `prisma init` downloads agent skill folders (`.agents/`, `.claude/skills/`, `.windsurf/`); they are git-ignored, not part of the project. `.claude/settings.json` and `.claude/hooks/` are committed.
