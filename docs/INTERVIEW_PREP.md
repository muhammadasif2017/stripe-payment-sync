# Interview Prep

Questions a buyer or interviewer may ask about this project, with answers in plain words. Grouped by stage.

## Stage 1: Project setup

**Why validate environment variables at startup instead of when they are used?**
If a secret is missing, the app should fail straight away with a clear message, not hours later on the first real payment. Failing at startup also means a bad deploy never starts serving traffic. The validator lists every problem at once, so you fix them in one go instead of one restart per variable.

**Why does the app reject Stripe live keys?**
This project is test mode only. Rejecting anything that doesn't start with `sk_test_` makes it impossible to charge real money by pasting the wrong key into `.env`.

**Why don't error messages include the bad value?**
Error messages end up in logs, and logs are read by more people than secrets should be. Joi prints the value by default when a pattern doesn't match, so the validator uses custom messages that name the variable but not its value. A test checks this.

**What does `PrismaService` do, and why is there only one?**
It is the Prisma client, registered once in a global module so any part of the app can inject it. Each Prisma client opens its own pool of database connections. One shared instance means one pool; creating clients in many places can exhaust PostgreSQL's connection limit.

**What are `onModuleInit` and `onModuleDestroy`?**
NestJS lifecycle hooks. `onModuleInit` opens the connection pool when the app starts. `onModuleDestroy` closes it when the app shuts down. NestJS only runs the shutdown hook on a signal like SIGTERM (what Docker sends to stop a container) if `app.enableShutdownHooks()` is called in `main.ts`. Without it, connections may stay open while the process exits.

**What is a Prisma driver adapter?**
In Prisma 7, the client talks to the database through a normal Node.js driver (here `pg`, via `@prisma/adapter-pg`) instead of a bundled engine binary. It is fewer moving parts, and it uses the same driver the rest of the Node ecosystem uses.

**Why does `/health` query the database instead of just returning ok?**
A health check that only proves the HTTP server is up can say "healthy" while every real request fails. Running `SELECT 1` proves the app can reach PostgreSQL. It returns 503 when it can't, so a load balancer or an uptime monitor can tell something is wrong.

**Is `/health` a liveness check or a readiness check?**
Readiness. A liveness check asks "is this process stuck, should it be restarted?" and must not depend on the database. A readiness check asks "can this instance serve requests right now?" and should. If `/health` were used as a liveness probe, a one-minute database outage would make Docker or Kubernetes restart every healthy API container in a loop. A separate database-free liveness route comes with the API container in a later stage.

**What happens if the database silently stops answering?**
By default node-postgres waits forever for a connection, so requests would hang instead of failing. `PrismaService` sets `connectionTimeoutMillis: 5000`: after 5 seconds the query fails and `/health` returns 503. A refused connection (database stopped) already fails straight away; the timeout covers the slower case, like a network drop.

**What happens if the app starts while the database is down?**
It starts anyway, and `/health` returns 503 until the database is back, then 200 without a restart. Prisma 7's driver adapter opens connections when they are first needed, so `$connect()` at startup does not fail. Tested by hand in stage 1.

**How do you know a test can actually fail?**
Break the code on purpose and check the test goes red. The review found a test that wrapped `expect.unreachable()` inside its own `try`, so the `catch` swallowed the failure and the test could never fail. After the fix, removing the message that hides the secret makes the test fail, as it should.

**Why doesn't the 503 response include the error details?**
The error can contain hostnames, ports or other internal details. Those go to the server log for the developer. The public response just says `{"status":"error"}`.

**Why are PostgreSQL and Redis bound to `127.0.0.1`?**
Docker publishes ports on every network interface by default. On a laptop on public Wi-Fi, that can expose the database to the network. Binding to `127.0.0.1` means only this machine can connect.

## Stage 2: Data model

**How do you stop a payment from being recorded twice?** (the client brief asks this directly)
At two levels. First, every Stripe event is stored with Stripe's event ID as the primary key. If Stripe delivers the same event twice, the second insert fails with a unique-constraint error (Prisma code `P2002`), and the event is processed only once. Second, every Stripe object ID is unique in its table: checkout session on `orders`, payment intent on `payments`, refund on `refunds`. Even if the same object arrives in two different events, the worker (stage 5) will upsert on that ID, so it updates one row instead of adding a second.

**Why not just check "does this event exist?" before inserting?**
Because two copies can arrive at the same moment. Both requests run the check, both see nothing, and both insert. A primary key or unique index is enforced inside the database, which handles concurrent inserts correctly: exactly one wins and the other gets an error. The test proves it, and it fails if the primary key is removed.

**Why store money as integers?**
Floating-point numbers can't represent most decimal fractions exactly: `0.1 + 0.2` is `0.30000000000000004` in JavaScript. With amounts in cents as integers, $49.99 is exactly `4999`. Stripe's API uses the same convention, so values are copied across with no conversion.

**Why store the currency if there is only one?**
An amount without a currency is ambiguous, and Stripe sends it on every object anyway. It costs one three-character column, and supporting more currencies later doesn't need a migration of existing rows.

**Why `ON DELETE RESTRICT` instead of `CASCADE`?**
Payment and refund records are financial history. With `CASCADE`, deleting an order would silently delete its payments too. `RESTRICT` makes the database refuse (Prisma code `P2003`), so removing payment data has to be a deliberate act.

**Why UUIDs for internal IDs?**
Sequential IDs like 1, 2, 3 reveal how many orders exist and make other orders easy to guess in a URL. PostgreSQL generates the UUIDs (`gen_random_uuid()`), so every way of inserting a row gets one.

**Why can an order have several payments?**
A customer's first card can be declined and a second one succeed. Keeping both attempts shows what happened, which matters when a customer asks why they see a failed charge.

**Why add indexes on `order_id` and `payment_id`?**
PostgreSQL indexes primary keys and unique columns automatically, but not foreign keys. Without the index, "all payments of this order" scans the whole payments table.

**Why a separate test database?**
The tests insert and delete rows. Run against the development database, a cleanup step could wipe data you were using. A guard refuses to start the tests if both URLs reach the same database (same host, port and name), or if the test database is on another machine without `ALLOW_REMOTE_TEST_DATABASE=true`, so a typo cannot aim the tests at a shared server.

**How do you know the constraint tests actually test the constraint?**
They were broken on purpose in the test database: dropping the primary key made the duplicate-event test fail, and switching the foreign key to `CASCADE` made the delete test fail. A test that still passes when the thing it checks is removed proves nothing.
**Why add CHECK constraints when the app validates amounts anyway?**
The app is not the only thing that writes rows: a bug in one handler, a script or a manual fix in `psql` can all skip the app's checks. `CHECK (amount > 0)` on orders, payments and refunds makes PostgreSQL refuse a zero or negative amount from any source. Prisma can't describe CHECK constraints in its schema, so they are in a hand-written migration, and Prisma ignores them when it compares the schema with the database.

**Why not also stop refunds from adding up to more than the payment in the database?**
That rule spans several rows, and a CHECK constraint can only see one row. It needs a trigger, which is harder to test and to change. The worker will check it before it saves a refund (stage 5), and reconciliation compares totals with Stripe.

**Which order and payment states are covered?**
Orders: `PENDING`, `PAID`, `PAYMENT_FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED`, and `EXPIRED` for a checkout session that ran out (`checkout.session.expired`). Payments: `SUCCEEDED`, `FAILED`, and `CANCELED` (`payment_intent.canceled`). Delayed payment methods such as bank debits, which sit in a "processing" state for days, are not covered because the project is card-only. Supporting them means adding a `PROCESSING` payment status.

**What are the known limits of this data model?**
- **Amount size:** amounts are 32-bit integers, so the largest is 2,147,483,647 cents (about $21 million) per row. Stripe allows larger amounts in some currencies, such as IDR. The fix is `BigInt`, at the cost of a JavaScript `bigint` type that can't go into JSON directly. Not needed for course sales in one currency.
- **Currency consistency:** each table stores its own currency, and nothing makes a payment's currency match its order's. With one currency this can't go wrong in practice. Supporting several would need the worker to check it, or the currency to come from the parent row.
## Tooling: working with an AI coding assistant

**How do you make sure an AI assistant follows the project's rules?**
Two layers. `CLAUDE.md` holds the rules and context the assistant reads at the start of every session: commands, conventions, boundaries. For the rules that must never be broken, a hook enforces them. Before every `git commit`, a script blocks the commit if the message names the assistant, if a `.env` file is included, or if lint, type check or unit tests fail. Instructions can be forgotten in a long session; a script that exits with an error cannot.

**Why not run every check in the hook?**
Speed. Lint, type check and unit tests take about 25 seconds. Adding the e2e tests (which need Docker) and the build would make every commit take about a minute. Those two stay a written rule, and the PR review catches what slips through.

**How do you know the hook works?**
It has unit tests, and they were proven to fail when the checks were switched off. It was also run by hand: a commit with a type error was blocked and showed the `tsc` error.

## Stage 3: Test checkout

**Why pin the Stripe library to an exact version?**
Each major version of `stripe` moves to a newer Stripe API version, and API versions can change the shape of responses. With `^23.0.0`, a fresh install could pick up different code than the tests ran against. The exact version, plus a unit test that compares the API version in the code with the library's, makes every upgrade a deliberate change.

**Why change the Stripe client's retries and timeout?**
The library's default timeout is 80 seconds, which is far too long for a customer waiting for the payment page. 20 seconds fails faster, and 2 automatic retries cover short network blips. Retries are safe because the library sends an idempotency key, so Stripe treats a retried request as the same request instead of creating a second session.

**Why is the price in the server's catalog and not in the request?**
Anything the browser sends can be edited. If the request carried the amount, anyone could open the developer tools and buy a course for 1 cent. The request carries only a course ID; the server looks up the name and price and sends those to Stripe.

**Why store `course_id` on the order?**
Without it, the database knows that 49 dollars were paid but not what for: the client couldn't grant access to the right course or report sales per course, which was one of their complaints.

**Why create the order before the Checkout Session?**
The session's metadata must carry the order ID, so the order has to exist first. The database insert and the call to Stripe can't share a transaction. If Stripe fails, the order stays `PENDING` with no session ID: no money moved, and the row records the attempt. The customer gets a generic 502 and can try again.

**What if saving the session ID fails after Stripe created the session?**
The request fails with a 500, so the customer never receives the payment page URL and nobody can pay that session. Stripe expires unused sessions after 24 hours. If it were paid somehow, its metadata still carries the order ID, so the webhook (stage 5) can find the order without the saved session ID.

**Why use the order ID as the idempotency key?**
If the request to Stripe times out after Stripe created the session, a retry with the same key returns that same session instead of creating a second one. One order can then never have two payment pages that could both be paid.

**Why put the order ID in two metadata places?**
Stripe doesn't copy a Checkout Session's metadata to the PaymentIntent it creates (Stripe's metadata docs say so). Some events, like `payment_intent.payment_failed`, carry only the PaymentIntent. `payment_intent_data.metadata` puts the order ID there too, so the worker in stage 5 can find the order from either event.

**Why return 502 and not the Stripe error?**
Stripe's error text can include details about the account or the API key. The client only needs to know that the payment provider failed and that it can retry. The full error, with Stripe's request ID for their support team, goes to the server log.

**Why only card payments?**
Some payment methods, such as bank debits, stay "processing" for days. The data model has no state for that yet, so the session uses `allowed_payment_method_types: ['card']`, where the result is known in seconds.

**What does the success page do, and why so little?**
It thanks the customer and says the payment is being confirmed. It changes nothing in the database. That was the client's original bug: their backend marked orders paid when the customer reached the success page, so a customer who closed the tab early paid but never got the course. Stripe's webhook arrives whether or not the browser does, so only the webhook (stages 4 and 5) marks an order paid.

**Why does the page load the course list from the API?**
So prices are written in one place, the server's catalog. A price copied into the HTML could drift from the one charged, and the page would show one amount while Stripe charged another.

## Stage 4: Webhook endpoint

**Why use the Stripe event ID as the job ID?**
BullMQ ignores a new job whose ID already exists. If Stripe delivers the same event twice, the second `add` does nothing, so the event is queued once. The database gives the same guarantee for the stored event, through the primary key. Completed jobs are kept for 7 days so a late duplicate still finds the old job.

**Why does the queue connection fail fast when Redis is down?**
By default the Redis client buffers commands until it reconnects, so the webhook request would hang. With the offline queue turned off, adding the job fails at once, the endpoint answers 500, and Stripe redelivers the event later. Stripe's retries become the safety net.

**How do you know a webhook really comes from Stripe?**
Stripe signs every request: the `Stripe-Signature` header holds an HMAC-SHA256 of a timestamp and the exact body, keyed with the endpoint's webhook secret. `stripe.webhooks.constructEvent` recomputes it and compares. Without the secret nobody can produce a valid signature, and changing one byte of the body breaks it. A wrong signature gets 400 and nothing is saved.

**Why does the signature check need the raw body?**
The HMAC covers the bytes Stripe sent. If the framework parses the JSON and the code turns it back into text, spaces, key order or number formatting can change and the signature never matches. NestJS's `rawBody: true` keeps the original bytes in `req.rawBody`.

**What stops someone replaying a real, captured webhook?**
The signed timestamp. `constructEvent` refuses signatures older than 5 minutes, so an old request fails even though its signature was once valid. Inside those 5 minutes a replay would be the same event ID, which the database stores only once.

**What happens if the database or Redis fails in the middle of a webhook?**
Each step is safe to repeat, so any failure is answered with 500 and Stripe's retry finishes the job. If the insert fails, nothing was saved and the redelivery inserts it. If the insert worked but queuing failed, the redelivery hits the primary key (treated as "already stored") and queues the job. If both worked but the 200 got lost, the redelivery changes nothing: same row, and BullMQ ignores the existing job ID. Stripe retries for up to 3 days.

**Why answer 200 to event types you don't handle?**
A non-2xx answer tells Stripe the delivery failed, so it would keep resending an event the system will never use. Answering 200 without saving it stops the retries and keeps `stripe_events` to the events that matter.

**Why does the webhook not update the order itself?**
Processing needs Stripe API calls and several database writes, which can be slow or fail. Stripe expects an answer within seconds and retries on a timeout, which would create duplicate work. The webhook only records the event; the worker (stage 5) does the work with its own retries, and the endpoint stays fast whatever happens downstream.

**How do you test webhooks on your own machine?**
Two ways. Automated tests sign their own payloads with `stripe.webhooks.generateTestHeaderString` and a test secret, so they need no network. For the real thing, the Stripe CLI's `stripe listen --forward-to localhost:3000/webhooks/stripe` opens a connection to Stripe and forwards test-mode events to the local app, signed with a secret it prints; `stripe trigger checkout.session.completed` creates a real test payment that fires the events.

## Stage 5: Worker with retries

**Why compute the order status instead of setting it per event?**
Stripe doesn't promise delivery order, and retries can run minutes later. If each event set a status ("refunded", then "paid" arriving late), the last one to run would win, even when it's stale. Computing the status from all the order's payments and refunds gives the same answer whatever the order of events. It is also a pure function, so every case has a unit test.

**Why does an expired order stay expired?**
When a checkout session expires, Stripe can also cancel its payment intent. If the cancellation is processed after the expiry, a status built only from payments would see "nothing paid, nothing failed" and go back to `PENDING`. The expiry is an input to the calculation, and it only gives way when money was actually paid.

**Why fetch the object from Stripe instead of using the event's copy?**
The event body is a snapshot from when it was created. By the time the job runs, the payment may have moved on: a declined card retried successfully, a refund added. Fetching the current object means the database always ends up matching Stripe, whatever order the events arrive in. The event only tells the worker what to look at.

**Why lock the order row?**
Two jobs for the same order can run at the same time, for example the payment and a quick refund. Each reads the payments and refunds, computes a status and writes it; without a lock, the slower one can overwrite the other with a status computed from stale rows. `SELECT ... FOR UPDATE` makes the second transaction wait until the first commits. Stripe is called before the transaction, so the lock is held for milliseconds, not for a network call.

**Which errors are retried and which are not?**
Retried: the database being down, network errors, Stripe rate limits and Stripe server errors, because they pass. Not retried: an event with no matching order, an amount or currency that doesn't match the order, or Stripe saying the object doesn't exist. Retrying those would fail five times in a row and hide the real problem, so they fail at once with the reason saved for someone to look at.

**How do you know which attempt is the last one?**
BullMQ's `attemptsMade` counts the attempts that already failed, so the running attempt is `attemptsMade + 1`; when that equals the job's `attempts` (5), no retry follows and the event is marked `FAILED`. A test makes the database fail on every attempt and checks the event ends `FAILED` with `attempts = 5`; counting off by one makes that test fail.

**Why can the worker be switched off?**
The API must answer Stripe fast, while the worker can be slow and retry. Running them as separate processes (same code, `WORKER_ENABLED=false` for the API) means a backlog of jobs never slows the webhook, and each can be scaled or restarted on its own. Stage 8's Docker Compose starts both.

**Show me the retries working.**
With the database stopped, the worker's jobs failed and BullMQ scheduled them again after 10 s and 20 s. When PostgreSQL came back, the next attempt finished the work: payment recorded, order `PAID`, event `PROCESSED` with `attempts = 4`. Nothing was lost because the event was already stored and the job was in Redis, not in the app's memory.

**What if the database is still down on the last attempt?**
The job fails in BullMQ, but the event can't be marked `FAILED` because the database is the problem; it stays `PENDING`. The failed job shows in the dashboard with a retry button (stage 6), and the daily reconciliation (stage 7) compares Stripe with the database and queues anything missed. Retries handle short outages; reconciliation handles the rest.

## Stage 6: Logging and dashboard

**How do you log calls to Stripe?**
Every call goes through one small function, `StripeCalls.run`, which takes the endpoint name, what the call is for (an event ID, or an order ID during checkout) and the call itself. It times the call and writes one line: endpoint, event, HTTP status, Stripe's request ID and duration. If the call fails it logs a warning and throws the same error on, so the code calling it behaves exactly as before.

**Why not use the Stripe library's built-in `response` event?**
It looked simpler, but reading the library's code showed it never fires when no response arrives, such as a connection error or a timeout, which are the failures you most want to see. It also runs on the shared client, so it can't know which Stripe event the worker is processing. The wrapper sees every outcome and gets the event ID passed in directly.

**Why log the Stripe request ID?**
Stripe gives every API request an ID (`req_...`). With it, Stripe support, or the Stripe dashboard's request log, can show exactly what was sent and what came back. It turns "a call failed around 3 pm" into one searchable line.

**How is the dashboard protected?**
With HTTP Basic auth, passed to Bull Board as its own middleware, so the page, its static files and its JSON API all go through the same check. The browser shows its built-in login box when it gets a 401 with `WWW-Authenticate: Basic`. The password is a required setting with at least 16 characters and no default, so the dashboard never runs with a known password. Tests send requests with no login to the page, a sub-page, the API and a static file, and expect 401 on each.

**Why hash before `timingSafeEqual`?**
A normal `===` stops at the first wrong character, so in theory the response time reveals how much of a guess was right. `timingSafeEqual` always compares every byte, but it throws when the two inputs have different lengths, which would leak the length. Hashing both sides with SHA-256 makes them always 32 bytes.

**Isn't Basic auth insecure?**
The password is only base64-encoded, so anyone who can read the traffic can read it. On localhost that's fine; anywhere else the app must sit behind HTTPS, which also encrypts the header. It has no logout and no lockout after many wrong guesses. For an internal admin page those limits are acceptable; a customer-facing login would need sessions, CSRF protection and rate limiting.

**Could another website make an admin's browser press dashboard buttons?**
Yes, until it was tested. The browser re-sends Basic credentials automatically, so a page on another site can submit a form to the dashboard (the attack is called CSRF). Most of Bull Board's actions are `PUT` requests, which a browser only sends cross-site after the server approves a CORS "preflight"; this app never approves one. But Bull Board also has `POST` routes, such as "add job", and a plain HTML form can send a POST with no preflight. A test showed such a request got 200 and added a job. The fix is a second check after the login: for any request that changes something, the browser's `Sec-Fetch-Site` header must say `same-origin` (or the `Origin` header must match the host). A page can't fake those headers. Requests with neither, like curl, don't come from a browser, so they can't be forged this way and pass. Tests send the forged form request (403, no job added) and a same-origin action (allowed).

**What does the retry button actually do?**
It calls BullMQ's `job.retry()`, which moves the failed job back to the waiting list. Bull Board doesn't reset the attempt counter, so after 5 failures the manual retry is attempt 6, gets one try, and the event's `attempts` column keeps the full count. Retrying a job that already completed is harmless because the worker skips events marked `PROCESSED`. Both are covered by tests that click the button through the dashboard's API with a real worker running.

**What do you keep out of the logs?**
Request and response bodies, and error messages. A Checkout Session contains the customer's email, and logs are often copied to other systems with wider access than the database. A unit test checks that an email in the call never appears in the output.

**Show me the dashboard working.**
A worker was started with a wrong Stripe key. Each attempt logged one line, such as `checkout.sessions.retrieve event=evt_… status=401 (StripeAuthenticationError) duration=116ms`, and after 5 attempts the event was `FAILED`. The dashboard showed the job in its Failed list with the error. After the worker restarted with the right key, one click on Retry ran attempt 6: the Stripe call returned 200, the payment was recorded and the order became `PAID`. A wrong key is a realistic failure (a rotated key not yet deployed), and it showed the logging and the dashboard in one run.

## Stage 7: Daily reconciliation

**Why do you need reconciliation if you have webhooks and retries?**
Webhooks can be missed: the endpoint was down longer than Stripe keeps retrying, a secret was rotated wrongly, or a bug dropped an event. Retries only help with events that arrived. Reconciliation asks Stripe directly what was paid and compares it with the database, so the database ends up right even when the event path failed. It is the difference between "usually correct" and "correct by the next morning".

**Why not re-queue the original Stripe event?**
Three reasons. The job for that event is still in Redis for 7 days, and BullMQ ignores a new job with the same ID. The worker skips events already marked `PROCESSED`. And the event may never have arrived, which is one of the cases reconciliation exists for. So a repair is its own job, keyed by the Checkout Session, and reuses the same "fetch the latest state, write it in one transaction" code.

**How does it decide what is missing?**
It lists the completed Checkout Sessions of the last 2 days from Stripe. A session needs repair when Stripe says it is paid, it carries the ID of an order that exists, and the database has no succeeded payment for its payment intent. That one rule covers a deleted row, a webhook that never came, an event stuck after the database was down, and a stale failed row. Sessions without an order ID (test events from `stripe trigger`) or with an unknown order are counted and skipped, never queued: those would fail every day. All the payments are loaded in one query, not one per session.

**Why a BullMQ job scheduler instead of a cron library?**
An in-process timer runs in every copy of the app, so two workers would reconcile twice, and a restart at the wrong moment skips a day. A BullMQ scheduler stores the schedule in Redis and creates one job per run, which exactly one worker takes. Runs get retries like any job, their result shows on the dashboard, and an admin can press "Run now".

**Why is each repair job ID unique per run?**
BullMQ ignores a job whose ID already exists, and completed jobs are kept for 7 days. A fixed ID like `reconcile-<session>` would make tomorrow's repair a silent no-op if today's had already run. Adding the run's timestamp makes every run's repairs real. Repairs are idempotent (upserts on Stripe IDs, status recomputed), so an occasional duplicate does no harm.

**What does Stripe's `created` filter take?**
Unix seconds. JavaScript dates are in milliseconds, and passing milliseconds would ask for sessions created thousands of years from now: the run would quietly find nothing. A unit test pins the exact number for a known date, and an e2e test checks what was sent to Stripe.

**Show me reconciliation working.**
A payment row was deleted from the development database, then "Run now" was pressed on the dashboard. The run listed 5 completed sessions from Stripe, found 2 paid sessions without a payment, and queued 2 repairs, which completed within a second. One was the deleted row. The other was a real gap nobody had planted: a test payment from before the webhook existed, whose order had sat at `PENDING` for a day. A second run found nothing missing. It is a good example of why the check exists: the webhook path had no way to know about that payment.

## Stage 7 follow-up: closing the known limits

**A repair fixed the payment. What happens to the event that got stuck?**
In the same transaction, the repair marks the payment's unsettled events `RECONCILED`: a separate status, because "the worker processed it" and "a repair made it right" are different facts and an audit needs the difference. The original error and attempt count stay on the row. Afterwards the event's failed job is removed from the dashboard, so the Failed list only shows what still needs a person.

**Why a partial index?**
The repair looks for unsettled events of one payment. Nearly every row in `stripe_events` is `PROCESSED`, so a normal index on `status` would be large and mostly useless. A partial index (`WHERE status <> 'PROCESSED'`) holds only the handful of open rows, stays tiny as the table grows, and lets PostgreSQL skip the whole processed history before it reads any JSON.

**What happens to a payment that can never be repaired?**
For example, a paid session whose amount doesn't match its order. Before, it was found missing every day and its repair failed every day: one more failed job per day, forever. Now the first permanent failure writes one row in `reconciliation_issues` with the reason. Later runs skip that session, count it, and log a daily "N open issues need review". Once someone fixes the data and sets `resolved_at`, the next run tries again, and a new failure reopens the same row. A problem becomes a to-do item instead of noise.

**Why block "Edit schedule" on the dashboard?**
Because it would lie. The worker registers the scheduler from `RECONCILIATION_CRON` at every start, so a change made on the dashboard lasts only until the next deploy or restart, and nothing says it was undone. One source of truth is safer: the dashboard refuses the edit with "Change RECONCILIATION_CRON instead", and the setting is checked at startup. "Run now" stays, because running once doesn't change the schedule.

**Did you ever see the 2-day window matter?**
Yes, by accident. The follow-up's manual check ran two days after the test payment it used, so reconciliation listed nothing and couldn't restore the deleted row. It was a useful reminder that the window is a real edge, not a theoretical one. The fix for that run was to queue the same repair job by hand from the dashboard; the longer-term fix would be a window option on the job for one-off catch-ups.

## Stage 8: Tests, CI and Docker

**What stops someone guessing the dashboard password?**
A 16-character minimum, and a rate limit: after 10 failed logins from one IP in 15 minutes, the dashboard answers 429 to that IP, even with the right password, until the window passes. Only failed logins count, so real use is never limited. The limit sits first in the middleware chain, so a locked-out client doesn't even reach the password check. The counts are in memory, which is fine for one API process; with several you would move them to Redis.

**Why does the production image install with `--omit=dev --omit=optional`?**
`@prisma/client` lists the Prisma CLI as an optional peer, so npm marks the CLI "devOptional" and `--omit=dev` alone keeps it. That would ship a migration tool and its dependencies, including 4 known vulnerabilities, in every container. Omitting optional packages too drops it, and the image's dependencies shrank from 444 MB to 190 MB. It was found by looking inside the built image, not by trusting the flag.

**What does CI check?**
Every push and pull request runs the same five checks as a developer (lint, type check, unit tests, build, e2e tests) against real PostgreSQL and Redis containers, plus an audit of the dependencies that actually ship. A second job builds the Docker image, starts the whole stack (migrations, API, worker) and checks that it answers. It needs no secrets: tests use dummy Stripe values and never call Stripe. Third-party actions are pinned to commit SHAs, because a version tag can be moved to different code.

**How do you know the CI would catch a broken test?**
By breaking one on purpose: a throwaway branch changed one expected value, CI went red at the unit test step and skipped the Docker job, and the branch was deleted.

**How do you know someone new can run it?**
By doing it: a fresh clone into an empty folder, following only the README's Docker section, with nothing from the development setup but the Stripe test key. The stack built, migrated itself and answered; a test payment made through the containers ended `PAID`. Two things only that test could show: Compose names projects after their folder (so a second copy with the same folder name would take over the first one's containers), and a clone made before the README was pushed tests the wrong README.

**Why does the image pin npm?**
The lockfile was written by npm 11; the Node 22.15 image ships npm 10, which resolves one optional peer dependency differently and refuses the lockfile with "Missing: typescript@5.9.3". Pinning npm 11.14.0 in the Dockerfile, in CI and in `packageManager` makes every install use the same resolver.


## Stage 9: Race fixes

**How did you find the race conditions?**
A pre-release review with three independent reviewers (code, security, tests), each with no shared context. Two of them found the same repair race on their own, which made it worth taking seriously. Every bug was then proved with a test that failed on the old code before anything was fixed.

**What was the repair race?**
A repair reads Stripe first, then writes in a transaction, and in that transaction it marked every unsettled event of the payment as settled. An event that arrived between the read and the write was marked too, even though the read never saw its change, and the worker then skipped it. A refund could stay pending forever. The fix: record the time just before the read and only settle events stored before it. Anything stored before the read describes a change the read already includes.

**Why use the database's clock?**
Because two clocks drift, and any drift reopens the race. Both times now come from PostgreSQL: the repair reads `now()`, and the event's `received_at` is the column default. The repair's time is rounded to milliseconds the same way as the column, so rounding can't make a later event look earlier.

**What went wrong while fixing it?**
I assumed the database set `received_at`, because the column has a default. A test failed once in about twenty runs. Logging Prisma's SQL showed Prisma Client sends its own value for `@default(now())`, from the app's clock, so the database default never ran. The fix was `@default(dbgenerated("CURRENT_TIMESTAMP"))`, so Prisma leaves the column out. To make the bug impossible to miss, a test moves the app's clock to the year 2000 and checks the stored time still matches the database. Lesson: a flaky test is a bug report; find the cause before rerunning.

**Did you change your plan after starting?**
Yes. The first fix for the second race was "never move a status backwards", based on which status changes I believed Stripe allows. When asked to justify it, I checked Stripe's docs: some refunds can go from `succeeded` back to `requires_action`. Not possible with cards, but the rule would silently break with another payment method. So the fix became "the newest read wins", which doesn't depend on Stripe's state machine. Lesson: a design that rests on facts about someone else's system should cite their docs, not memory.
