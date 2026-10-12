CREATE TYPE "public"."leave_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"days" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "leave_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "leave_requests_span_chk" CHECK ("leave_requests"."to_date" >= "leave_requests"."from_date")
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "self_marked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "in_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "in_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "in_distance_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "out_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "out_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "out_distance_m" integer;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "leave_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "leave_requests_status_idx" ON "leave_requests" USING btree ("status");