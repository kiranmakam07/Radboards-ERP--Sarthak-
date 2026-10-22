-- Unit serials and batches (P1): units fit inside each other, unit_events is their append-only history, and for a serialised item every stock movement names its one unit.
CREATE TYPE "public"."unit_status" AS ENUM('available', 'reserved', 'demo', 'under_repair', 'quarantine', 'damaged', 'rtv', 'sold', 'scrapped');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"mfg_date" date,
	"chemistry" text,
	"weight_kg" numeric(10, 3),
	"supplier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "batches_item_no_uq" UNIQUE("item_id","batch_no")
);
--> statement-breakpoint
CREATE TABLE "unit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"from_status" "unit_status",
	"to_status" "unit_status",
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"serial_no" text NOT NULL,
	"parent_unit_id" uuid,
	"bpan" char(21),
	"firmware_version" text,
	"batch_id" uuid,
	"mfg_date" date,
	"status" "unit_status" DEFAULT 'available' NOT NULL,
	"location_id" uuid,
	"sold_delivery_line_id" uuid,
	"sold_invoice_line_id" uuid,
	"sold_on" date,
	"last_charged_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "units_bpan_unique" UNIQUE("bpan"),
	CONSTRAINT "units_item_serial_uq" UNIQUE("item_id","serial_no"),
	CONSTRAINT "units_not_own_parent" CHECK ("units"."parent_unit_id" is null or "units"."parent_unit_id" <> "units"."id")
);
--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD COLUMN "serials" jsonb;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "serials" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "is_serialised" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "charge_every_days" integer;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "serials" jsonb;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD COLUMN "serials" jsonb;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_supplier_id_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_events" ADD CONSTRAINT "unit_events_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_events" ADD CONSTRAINT "unit_events_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_events" ADD CONSTRAINT "unit_events_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_parent_unit_id_units_id_fk" FOREIGN KEY ("parent_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_sold_delivery_line_id_delivery_lines_id_fk" FOREIGN KEY ("sold_delivery_line_id") REFERENCES "public"."delivery_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_sold_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("sold_invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unit_events_unit_idx" ON "unit_events" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "units_serial_idx" ON "units" USING btree ("serial_no");--> statement-breakpoint
CREATE INDEX "units_parent_idx" ON "units" USING btree ("parent_unit_id");--> statement-breakpoint
CREATE INDEX "units_location_idx" ON "units" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_unit_idx" ON "stock_movements" USING btree ("unit_id");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_qty_chk" CHECK ("stock_movements"."unit_id" is null or abs("stock_movements"."qty") = 1);--> statement-breakpoint
-- A unit's history is append-only, like the stock ledger (RC001).
CREATE TRIGGER unit_events_append_only BEFORE UPDATE OR DELETE ON unit_events
  FOR EACH ROW EXECUTE FUNCTION rc_block_mutation();
