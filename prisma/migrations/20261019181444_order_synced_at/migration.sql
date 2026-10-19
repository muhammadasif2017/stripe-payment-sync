-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "synced_at" TIMESTAMPTZ(3);

-- Hand-written: Prisma's schema language cannot express a trigger.
-- received_at must come from the database's clock, because reconciliation repairs compare it with
-- the database's now() to know which events their Stripe snapshot already covers. Prisma Client
-- fills @default(now()) itself, from the app's clock, so the column default alone never runs. The
-- trigger overwrites whatever value an INSERT sends. now() is the inserting transaction's start time.
CREATE FUNCTION stripe_events_set_received_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.received_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stripe_events_received_at
BEFORE INSERT ON stripe_events
FOR EACH ROW EXECUTE FUNCTION stripe_events_set_received_at();
