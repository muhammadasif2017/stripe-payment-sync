# Stage 10 – Hardening: Tasks

Every task: a test that fails without the change, the five checks, the three docs updated, one commit.

## Task 1: Rate limit on `POST /checkout` (M-1)

- [ ] 10 requests per minute per IP on `POST /checkout`; 429 with a JSON message, logged with the IP
- [ ] `GET /checkout/courses` is not limited
- [ ] Own e2e file and app; fails with the middleware removed

## Task 2: `TRUST_PROXY` and `HOST` (L-2, L-4)

- [ ] `TRUST_PROXY`: `false` (default), hop count, or IPs/subnets; `true` refused at startup
- [ ] `HOST`: default `127.0.0.1`; Compose sets `0.0.0.0`
- [ ] `configureApp(app)` in `app.setup.ts`, used by `main.ts` and `createTestApp`
- [ ] Unit tests for validation; e2e for `req.ip` with and without `TRUST_PROXY`
- [ ] `.env.example`, README configuration table

## Task 3: Security headers (L-3)

- [ ] `helmet()` with `frame-ancestors 'none'`, without `upgrade-insecure-requests`
- [ ] Checkout page script moved to `public/checkout.js`
- [ ] e2e asserts headers on `/`, the API and `/admin/queues`; no `X-Powered-By`
- [ ] Browser check: `/` and `/admin/queues` work, no CSP errors in the console

## Task 4: Shutdown order

- [ ] Processors close their workers in `onModuleDestroy`
- [ ] `PrismaService` disconnects in `onApplicationShutdown`
- [ ] Worker `stop_grace_period` in Compose
- [ ] e2e: a job running during `app.close()` completes and its writes land; fails before the change

## Task 5: Re-queue lost events

- [ ] Daily reconciliation re-queues `PENDING` events received over 1 hour ago; existing jobs untouched
- [ ] Summary gains `requeued`
- [ ] e2e: lost event re-queued and processed; recent event and event with a job left alone

## Task 6: Trimmed payloads (L-7)

- [ ] Only `id`, `type`, `created`, `livemode`, `api_version` and `data.object` `{id, object, payment_intent}` stored
- [ ] Expanded `payment_intent` stored as its ID
- [ ] Existing rows trimmed by a migration (decision 2); user confirms before it runs on `payments`
- [ ] Unit test of trimming; e2e webhook with customer details stored without them and still processed

## Task 7: Passwords (L-5)

- [ ] Redis `--requirepass`, required `REDIS_PASSWORD`; healthcheck and container URLs use it
- [ ] `POSTGRES_PASSWORD` required, empty in `.env.example`
- [ ] CI docker job sets both
- [ ] Local `.env` updated without printing values; Redis container recreated, data kept

## Task 8: Node, digests, Dependabot, scan (M-2)

- [ ] Node 24.22.0 (decision 1), pinned by digest in both `FROM` lines; CI, `engines`, README, `CLAUDE.md`
- [ ] `postgres` and `redis` images pinned by digest
- [ ] `.github/dependabot.yml`: npm, docker, github-actions; Prisma grouped; no Node or Prisma majors
- [ ] Trivy in the CI docker job, failing on fixable HIGH/CRITICAL (decision 3); baseline run locally first

## Task 9: Checkpoint

- [ ] Five checks pass
- [ ] Stack started as a separate Compose project; `/health`, `/`, dashboard login, clean stop
- [ ] Docs complete
- [ ] Branch review, then PR
- [ ] Human review and merge
