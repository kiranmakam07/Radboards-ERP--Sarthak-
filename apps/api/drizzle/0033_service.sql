-- Service and warranty (P2 of the brief): warranty rules, fault codes, job cards with their lines, photos and faults, supplier claims; the technician and service manager roles; the service sales channel; parts fitted on a job card as a stock movement; service photos as a kind of file.
CREATE TYPE "public"."claim_status" AS ENUM('draft', 'sent', 'accepted', 'rejected', 'credited');--> statement-breakpoint
CREATE TYPE "public"."job_card_status" AS ENUM('open', 'diagnosed', 'estimate_sent', 'approved', 'in_progress', 'ready', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_line_kind" AS ENUM('part', 'labour');--> statement-breakpoint
ALTER TYPE "public"."sales_channel" ADD VALUE 'service';--> statement-breakpoint
ALTER TYPE "public"."movement_type" ADD VALUE 'service_issue';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'technician';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'service_manager';--> statement-breakpoint
CREATE TABLE "fault_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"component" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "fault_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "job_card_faults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_card_id" uuid NOT NULL,
	"fault_code_id" uuid NOT NULL,
	"unit_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "job_card_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_card_id" uuid NOT NULL,
	"kind" "job_line_kind" NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(12, 2) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"is_warranty" boolean DEFAULT false NOT NULL,
	"issued_qty" numeric(12, 3) DEFAULT '0' NOT NULL,
	"issued_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"serials" jsonb,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_card_lines_qty_chk" CHECK ("job_card_lines"."qty" > 0 and "job_card_lines"."issued_qty" >= 0 and "job_card_lines"."issued_qty" <= "job_card_lines"."qty")
);
--> statement-breakpoint
CREATE TABLE "job_card_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_card_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"caption" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "job_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_no" text NOT NULL,
	"entity_id" uuid DEFAULT rc_default_entity() NOT NULL,
	"unit_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "job_card_status" DEFAULT 'open' NOT NULL,
	"complaint" text NOT NULL,
	"diagnosis" text,
	"technician_id" uuid,
	"odometer_km" integer,
	"battery_cycles" integer,
	"promised_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"estimate_token" text,
	"approved_at" timestamp with time zone,
	"approved_via" text,
	"unit_status_before" "unit_status",
	"tax_inclusive" boolean DEFAULT true NOT NULL,
	"sales_order_id" uuid,
	"invoice_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_cards_job_no_unique" UNIQUE("job_no"),
	CONSTRAINT "job_cards_estimate_token_unique" UNIQUE("estimate_token")
);
--> statement-breakpoint
CREATE TABLE "supplier_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_card_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"status" "claim_status" DEFAULT 'draft' NOT NULL,
	"evidence" jsonb,
	"amount" numeric(12, 2),
	"credit_note_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "warranty_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"months" integer NOT NULL,
	"km_limit" integer,
	"cycle_limit" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "warranty_rules_limits_chk" CHECK ("warranty_rules"."months" > 0 and ("warranty_rules"."km_limit" is null or "warranty_rules"."km_limit" > 0) and ("warranty_rules"."cycle_limit" is null or "warranty_rules"."cycle_limit" > 0))
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_chk";--> statement-breakpoint
ALTER TABLE "job_card_faults" ADD CONSTRAINT "job_card_faults_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_faults" ADD CONSTRAINT "job_card_faults_fault_code_id_fault_codes_id_fk" FOREIGN KEY ("fault_code_id") REFERENCES "public"."fault_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_faults" ADD CONSTRAINT "job_card_faults_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_lines" ADD CONSTRAINT "job_card_lines_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_lines" ADD CONSTRAINT "job_card_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_media" ADD CONSTRAINT "job_card_media_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_media" ADD CONSTRAINT "job_card_media_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_claims" ADD CONSTRAINT "supplier_claims_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_claims" ADD CONSTRAINT "supplier_claims_supplier_id_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_claims" ADD CONSTRAINT "supplier_claims_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_rules" ADD CONSTRAINT "warranty_rules_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_card_faults_job_idx" ON "job_card_faults" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "job_card_lines_job_idx" ON "job_card_lines" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "job_card_media_job_idx" ON "job_card_media" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "job_cards_unit_idx" ON "job_cards" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "job_cards_status_idx" ON "job_cards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "supplier_claims_job_idx" ON "supplier_claims" USING btree ("job_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_rules_item_uq" ON "warranty_rules" USING btree ("item_id") WHERE "warranty_rules"."active";--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_chk" CHECK ("files"."purpose" in ('resume', 'bill', 'item_image', 'share', 'other', 'service'));