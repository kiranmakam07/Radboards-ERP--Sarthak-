-- Personal data (DPDP, brief P3): when and how each lead and party agreed to be contacted, and a log of who opened a customer's full record.
CREATE TABLE "access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "consent_source" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "consent_source" text;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_log_record_idx" ON "access_log" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "access_log_at_idx" ON "access_log" USING btree ("at");