CREATE TABLE "follow_up_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "plan_step" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "plan_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_plan_id_follow_up_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."follow_up_plans"("id") ON DELETE no action ON UPDATE no action;