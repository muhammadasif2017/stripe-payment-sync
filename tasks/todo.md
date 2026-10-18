# Stage 8 – Tests, CI and Docker: Tasks

## Task 1: Docker image, Compose services, dependency audit

**Description:** A multi-stage Dockerfile and an `app` Compose profile that runs migrations, the API and the worker; fix the stage 1 `postinstall` problem; apply the non-breaking audit fix.

**Acceptance criteria:**
- [x] `Dockerfile` (build, runtime, migrate) on `node:22.15.0-alpine`; runtime uses `npm ci --omit=dev --omit=optional --ignore-scripts`, runs as `node`, has a `/health` healthcheck, contains `dist/` and `public/` (migrations run from the `migrate` target)
- [x] `.dockerignore` keeps `.env`, `node_modules`, `dist`, `.git` and local folders out
- [x] Compose `app` profile: `migrate` (once), `api` (`WORKER_ENABLED=false`, `127.0.0.1:3000`), `worker`; URLs point at service names; `init: true`; `docker compose up -d` unchanged
- [x] `npm audit fix` (no `--force`) tried; reverted because it split Prisma versions; remaining findings documented (none in the runtime image)

**Verification:**
- [x] `docker compose --profile app up --build`: migrations applied, `/health` 200, `/` serves the checkout page, the dashboard answers 401 without a login, the worker logs the reconciliation schedule
- [x] The image has no `.env` and the process runs as `node`
- [x] `docker compose --profile app down` stops cleanly (SIGTERM handled)

**Dependencies:** None

**Files likely touched:** `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `package-lock.json`

**Estimated scope:** Medium

## Task 2: Dashboard login rate limit (decision 3)

**Acceptance criteria:**
- [x] After 10 failed logins from one IP in 15 minutes, `/admin/queues` answers 429 until the window passes; successful logins don't count
- [x] Limit applies only to the dashboard

**Verification:**
- [x] e2e: 10 wrong passwords, then the 11th request (even with the right password) gets 429; another route is unaffected
- [x] Prove the test can fail

**Dependencies:** None

**Files likely touched:** `src/admin/*`, `package.json`, `test/admin.e2e-spec.ts`

**Estimated scope:** Small

## Checkpoint: Images and app
- [x] Tasks 1–2 verified, all five checks pass, commit

## Task 3: GitHub Actions workflow

**Acceptance criteria:**
- [ ] `.github/workflows/ci.yml` on push and pull request; actions pinned to SHAs; `permissions: contents: read`; concurrency group
- [ ] Job `checks`: PostgreSQL 17 and Redis 7 services; `npm ci`, lint, typecheck, unit, build, e2e, `npm audit --omit=dev --audit-level=high`
- [ ] Job `docker`: builds the image and starts the `app` profile with dummy settings; waits for `/health` 200

**Verification:**
- [ ] Both jobs green on the pushed branch
- [ ] A deliberately failing unit test makes the run red (on a throwaway commit, then reverted)

**Dependencies:** Task 1

**Files likely touched:** `.github/workflows/ci.yml`

**Estimated scope:** Small to medium

## Task 4: README, fresh-clone check, docs and pull request

**Acceptance criteria:**
- [ ] README: Docker-only run section, CI badge, "Why a queue", diagram check against `PROJECT.md`, Compose settings, roadmap ticked, deployment note on HTTPS
- [ ] Fresh clone in a scratch folder, following only the README: `/health` 200, dashboard login, a card 4242 payment ends `PAID` through the containers; cleaned up afterwards
- [ ] `CLAUDE.md`, `docs/BUILD_LOG.md`, `docs/TECH_STACK.md`, `docs/INTERVIEW_PREP.md`
- [ ] PR from `stage-8-ci-docker` to `main`, CI green

**Dependencies:** Tasks 1–3

**Estimated scope:** Medium

## Checkpoint: Stage 8 complete
- [ ] All five checks pass locally and in CI
- [ ] Stage 8 "Done when" from `PROJECT.md` met
- [ ] Commit, push, open PR
- [ ] Human review and merge
