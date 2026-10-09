CREATE TABLE "ad_spends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"detail" text,
	"spend_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "ad_spends_amount_chk" CHECK ("ad_spends"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "ad_spends" ADD CONSTRAINT "ad_spends_source_id_lead_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lead_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_spends_date_idx" ON "ad_spends" USING btree ("spend_date");