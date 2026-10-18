-- Hand-written: Prisma's schema language cannot express a partial index, so it lives only here.
-- Reconciliation repairs look up the events of a payment that are not settled yet (PENDING or
-- FAILED). Almost every row is PROCESSED, so indexing only the other rows keeps the index tiny
-- and lets the lookup skip the processed history before it reads any JSON.
CREATE INDEX "stripe_events_unsettled_idx" ON "stripe_events" ("status") WHERE "status" <> 'PROCESSED';
