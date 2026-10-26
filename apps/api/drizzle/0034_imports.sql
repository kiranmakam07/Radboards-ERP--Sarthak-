-- Imports (P2 of the brief): shipments with their purchase orders and stages, landed cost lines and how they were spread over the goods; item weight for spreading by weight; a forwarder's bill can name its shipment; a value-only stock movement (revaluation) for landed cost added later.
CREATE TYPE "public"."import_stage" AS ENUM('pi', 'advance_paid', 'production', 'shipped', 'at_port', 'boe_filed', 'cleared', 'received');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_basis" AS ENUM('value', 'qty', 'weight');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_kind" AS ENUM('freight', 'insurance', 'bcd', 'sws', 'igst', 'cha', 'port', 'inland', 'other');--> statement-breakpoint
ALTER TYPE "public"."movement_type" ADD VALUE 'revaluation';--> statement-breakpoint
CREATE TABLE "import_shipment_orders" (
	"shipment_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	CONSTRAINT "import_shipment_orders_uq" UNIQUE("shipment_id","purchase_order_id")
);
--> statement-breakpoint
CREATE TABLE "import_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_no" text NOT NULL,
	"entity_id" uuid DEFAULT rc_default_entity() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"fx_rate" numeric(12, 6),
	"stage" "import_stage" DEFAULT 'pi' NOT NULL,
	"stage_dates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bl_awb_no" text,
	"boe_no" text,
	"boe_date" date,
	"documents" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "import_shipments_shipment_no_unique" UNIQUE("shipment_no")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"cost_line_id" uuid NOT NULL,
	"grn_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"to_stock" numeric(12, 2) NOT NULL,
	"to_cogs" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landed_cost_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"applied_on" date NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"to_stock" numeric(12, 2) NOT NULL,
	"to_cogs" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "landed_cost_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" "landed_cost_kind" NOT NULL,
	"description" text,
	"amount" numeric(12, 2) NOT NULL,
	"basis" "landed_cost_basis" DEFAULT 'value' NOT NULL,
	"paid_from_account_id" uuid,
	"purchase_bill_id" uuid,
	"application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "landed_cost_lines_amount_chk" CHECK ("landed_cost_lines"."amount" > 0),
	CONSTRAINT "landed_cost_lines_source_chk" CHECK (("landed_cost_lines"."paid_from_account_id" is null) <> ("landed_cost_lines"."purchase_bill_id" is null))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_qty_nonzero";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "weight_kg" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "import_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "import_shipment_orders" ADD CONSTRAINT "import_shipment_orders_shipment_id_import_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."import_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_shipment_orders" ADD CONSTRAINT "import_shipment_orders_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_supplier_id_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_application_id_landed_cost_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."landed_cost_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_cost_line_id_landed_cost_lines_id_fk" FOREIGN KEY ("cost_line_id") REFERENCES "public"."landed_cost_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_grn_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("grn_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_allocations" ADD CONSTRAINT "landed_cost_allocations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_applications" ADD CONSTRAINT "landed_cost_applications_shipment_id_import_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."import_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_shipment_id_import_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."import_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_purchase_bill_id_purchase_bills_id_fk" FOREIGN KEY ("purchase_bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_application_id_landed_cost_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."landed_cost_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landed_cost_allocations_application_idx" ON "landed_cost_allocations" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "landed_cost_applications_shipment_idx" ON "landed_cost_applications" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "landed_cost_lines_shipment_idx" ON "landed_cost_lines" USING btree ("shipment_id");--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_import_shipment_id_import_shipments_id_fk" FOREIGN KEY ("import_shipment_id") REFERENCES "public"."import_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_qty_nonzero" CHECK ("stock_movements"."qty" <> 0 or "stock_movements"."movement_type"::text = 'revaluation');