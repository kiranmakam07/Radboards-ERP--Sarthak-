CREATE TABLE "fiscal_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fy" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"entry_id" uuid,
	"income" numeric(16, 2) DEFAULT '0' NOT NULL,
	"expense" numeric(16, 2) DEFAULT '0' NOT NULL,
	"profit" numeric(16, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "fiscal_closes_fy_unique" UNIQUE("fy")
);
--> statement-breakpoint
ALTER TABLE "fiscal_closes" ADD CONSTRAINT "fiscal_closes_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;