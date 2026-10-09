CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "message_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "channel_events" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "channel_events" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_events_status_idx" ON "channel_events" USING btree ("status","created_at");