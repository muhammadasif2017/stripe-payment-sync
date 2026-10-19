-- The database default is unchanged. What changes is the schema: received_at is now
-- @default(dbgenerated(...)) instead of @default(now()), so Prisma Client stops sending its own
-- (app clock) value and the database sets it. Repairs compare received_at with the database clock.
-- AlterTable
ALTER TABLE "stripe_events" ALTER COLUMN "received_at" SET DEFAULT CURRENT_TIMESTAMP;
