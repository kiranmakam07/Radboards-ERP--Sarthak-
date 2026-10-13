CREATE TABLE "bank_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"match_from" text,
	"match_subject" text,
	"password_sealed" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "bank_feeds_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "bank_feeds_rule_chk" CHECK ("bank_feeds"."match_from" is not null or "bank_feeds"."match_subject" is not null)
);
--> statement-breakpoint
CREATE TABLE "bank_mails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"part" integer DEFAULT 0 NOT NULL,
	"from_address" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"account_id" uuid,
	"attachment_name" text,
	"attachment" "bytea",
	"status" text NOT NULL,
	"detail" text,
	"import_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "bank_mails_message_uq" UNIQUE("message_id","part"),
	CONSTRAINT "bank_mails_status_chk" CHECK ("bank_mails"."status" in ('imported', 'failed', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "bank_feeds" ADD CONSTRAINT "bank_feeds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_mails" ADD CONSTRAINT "bank_mails_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;