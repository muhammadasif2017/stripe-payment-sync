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
