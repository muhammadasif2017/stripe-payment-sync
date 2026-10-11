# Tech Stack

Why each piece is here. Updated as each stage adds something.

## NestJS 12 (TypeScript)

A Node.js framework that organizes code into modules, controllers and services, and wires them together with dependency injection. The client brief asks for NestJS, and the structure helps here: the webhook endpoint, the queue worker and the reconciliation job are separate modules that share the same database service.

## TypeScript strict mode

The compiler catches mistakes like a possibly-missing value before the code runs. In payment code, a value that is quietly `undefined` can mean a payment is never recorded.

## PostgreSQL 17

The main database for orders, payments, refunds and Stripe events. It supports transactions, so an order and its payment update together or not at all. It also enforces unique keys, which is how each Stripe event gets processed only once (stage 2).

## Prisma 7

The ORM: it turns a schema file into database migrations and a typed client. A typo in a column name becomes a compile error instead of a runtime error. Version 7 connects through a *driver adapter* (`@prisma/adapter-pg`, which uses the `pg` library) instead of a separate query engine binary, so there is less to install.

## Redis 7

An in-memory data store. BullMQ keeps its job queue in Redis from stage 4, so jobs survive an API restart. Redis runs with append-only persistence (`--appendonly yes`) on a named Docker volume, so queued and failed jobs also survive a Redis restart or a recreated container.

## Docker Compose

Starts PostgreSQL and Redis with one command, the same versions on every machine. Nobody has to install a database by hand to run the project.

## @nestjs/config + Joi

`@nestjs/config` loads `.env` and makes settings available through `ConfigService`. Joi checks those settings at startup. A missing secret stops the app straight away with a clear message, instead of failing later on the first payment.

## Vitest

The test runner that NestJS 12 sets up by default. It uses the same `describe`/`it`/`expect` style as Jest and runs fast. `supertest` sends real HTTP requests in the end-to-end tests.

## oxlint and Prettier

oxlint finds likely bugs and bad patterns. Prettier formats code the same way every time. Both came with the NestJS scaffold.
