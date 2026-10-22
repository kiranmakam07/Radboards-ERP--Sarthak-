-- Entities and branches (P1): every document, number series, journal and place belongs to a legal entity; existing rows to the first one.
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"state_code" char(2) NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "branches_entity_name_uq" UNIQUE("entity_id","name")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text,
	"state_code" char(2) NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"code" char(1),
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "entities_code_unique" UNIQUE("code")
);
--> statement-breakpoint
-- The first entity is the company in the profile (or Radboards, state 27, on a database not yet set up).
INSERT INTO "entities" ("legal_name", "gstin", "state_code", "address", "is_default")
  SELECT coalesce(nullif(value->>'legal_name', ''), nullif(value->>'name', ''), 'Radboards Pvt Ltd'), nullif(value->>'gstin', ''),
         coalesce(nullif(value->>'state_code', ''), '27'), coalesce(value->'address', '{}'::jsonb), true
    FROM "settings" WHERE "key" = 'company'
  UNION ALL
  SELECT 'Radboards Pvt Ltd', NULL, '27', '{}'::jsonb, true WHERE NOT EXISTS (SELECT 1 FROM "settings" WHERE "key" = 'company');--> statement-breakpoint
-- What every existing row (and every new one that names none) belongs to.
CREATE FUNCTION rc_default_entity() RETURNS uuid AS $$
  SELECT id FROM entities WHERE is_default LIMIT 1
$$ LANGUAGE sql STABLE;--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_doc_fy";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "entity_id" uuid DEFAULT rc_default_entity() NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_one_default" ON "entities" USING btree ("is_default") WHERE "entities"."is_default";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_doc_fy" UNIQUE("doc_type","fy","entity_id");