CREATE TABLE "lead_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"token" text NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"first_viewed_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "lead_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_chk";--> statement-breakpoint
ALTER TABLE "lead_shares" ADD CONSTRAINT "lead_shares_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_shares" ADD CONSTRAINT "lead_shares_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_shares_lead_idx" ON "lead_shares" USING btree ("lead_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_chk" CHECK ("files"."purpose" in ('resume', 'bill', 'item_image', 'share', 'other'));