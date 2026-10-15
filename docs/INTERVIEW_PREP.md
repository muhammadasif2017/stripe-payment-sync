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
