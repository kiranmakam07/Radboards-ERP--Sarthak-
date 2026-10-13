CREATE TYPE "public"."job_work_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."location_type" ADD VALUE 'job_work';--> statement-breakpoint
ALTER TYPE "public"."movement_type" ADD VALUE 'job_work';--> statement-breakpoint
CREATE TABLE "job_work_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_work_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_work_lines_item_uq" UNIQUE("job_work_id","item_id"),
	CONSTRAINT "job_work_lines_qty_pos" CHECK ("job_work_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_work_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"job_work_line_id" uuid,
	"item_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"charge_share" numeric(12, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "job_work_receipt_lines_kind_chk" CHECK ("job_work_receipt_lines"."kind" in ('returned', 'consumed', 'produced', 'lost')),
	CONSTRAINT "job_work_receipt_lines_qty_pos" CHECK ("job_work_receipt_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_work_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"job_work_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"to_location_id" uuid NOT NULL,
	"worker_challan_no" text,
	"charge" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"status" "posted_status" DEFAULT 'posted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_work_receipts_receipt_no_unique" UNIQUE("receipt_no"),
	CONSTRAINT "job_work_receipts_charge_chk" CHECK ("job_work_receipts"."charge" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challan_no" text NOT NULL,
	"challan_date" date NOT NULL,
	"job_worker_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"process" text NOT NULL,
	"expected_back_on" date,
	"transport" text,
	"notes" text,
	"status" "job_work_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_works_challan_no_unique" UNIQUE("challan_no")
);
--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "job_work_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "job_work_cleared" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_work_lines" ADD CONSTRAINT "job_work_lines_job_work_id_job_works_id_fk" FOREIGN KEY ("job_work_id") REFERENCES "public"."job_works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_lines" ADD CONSTRAINT "job_work_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_lines" ADD CONSTRAINT "job_work_receipt_lines_receipt_id_job_work_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."job_work_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_lines" ADD CONSTRAINT "job_work_receipt_lines_job_work_line_id_job_work_lines_id_fk" FOREIGN KEY ("job_work_line_id") REFERENCES "public"."job_work_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_lines" ADD CONSTRAINT "job_work_receipt_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipts" ADD CONSTRAINT "job_work_receipts_job_work_id_job_works_id_fk" FOREIGN KEY ("job_work_id") REFERENCES "public"."job_works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipts" ADD CONSTRAINT "job_work_receipts_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_works" ADD CONSTRAINT "job_works_job_worker_id_parties_id_fk" FOREIGN KEY ("job_worker_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_works" ADD CONSTRAINT "job_works_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_work_receipt_lines_receipt_idx" ON "job_work_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "job_work_receipts_job_idx" ON "job_work_receipts" USING btree ("job_work_id");--> statement-breakpoint
CREATE INDEX "job_works_worker_idx" ON "job_works" USING btree ("job_worker_id");--> statement-breakpoint
CREATE INDEX "job_works_status_idx" ON "job_works" USING btree ("status");--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_job_work_id_job_works_id_fk" FOREIGN KEY ("job_work_id") REFERENCES "public"."job_works"("id") ON DELETE no action ON UPDATE no action;