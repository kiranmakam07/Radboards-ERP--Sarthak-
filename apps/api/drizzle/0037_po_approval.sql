-- Amount-based purchase order approval (brief P3): a limit per role, and the pending approval status for a PO above it.
ALTER TYPE "public"."po_status" ADD VALUE 'pending_approval';--> statement-breakpoint
CREATE TABLE "po_approval_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "user_role" NOT NULL,
	"max_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "po_approval_limits_role_unique" UNIQUE("role"),
	CONSTRAINT "po_approval_limits_amount_chk" CHECK ("po_approval_limits"."max_amount" >= 0)
);
