-- AlterEnum
ALTER TYPE "stripe_event_status" ADD VALUE 'RECONCILED';

-- CreateTable
CREATE TABLE "reconciliation_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stripe_checkout_session_id" TEXT NOT NULL,
    "order_id" UUID,
    "reason" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "reconciliation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_issues_stripe_checkout_session_id_key" ON "reconciliation_issues"("stripe_checkout_session_id");
