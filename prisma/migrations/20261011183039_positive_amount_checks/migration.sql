-- Hand-written: Prisma's schema language cannot express CHECK constraints, so they live only here.
-- Amounts are in the smallest currency unit and must be positive. A refund is stored as a
-- positive amount even though money goes back to the customer.
-- Not enforced here: refunds adding up to more than their payment. That needs a trigger;
-- the worker checks it instead (stage 5).

ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);
