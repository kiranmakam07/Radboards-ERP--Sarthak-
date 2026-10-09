CREATE TYPE "public"."bank_line_status" AS ENUM('unmatched', 'matched', 'ignored');--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"txn_date" date NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reference" text,
	"amount" numeric(12, 2) NOT NULL,
	"balance" numeric(14, 2),
	"import_id" uuid NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"line_hash" text NOT NULL,
	"status" "bank_line_status" DEFAULT 'unmatched' NOT NULL,
	"matched_journal_line_id" bigint,
	"matched_at" timestamp with time zone,
	"matched_by" uuid,
	"ignore_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "bank_statement_lines_hash_uq" UNIQUE("account_id","line_hash"),
	CONSTRAINT "bank_statement_lines_amount_nonzero" CHECK ("bank_statement_lines"."amount" <> 0),
	CONSTRAINT "bank_statement_lines_match_chk" CHECK (("bank_statement_lines"."status" = 'matched') = ("bank_statement_lines"."matched_journal_line_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("matched_journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_match_uq" ON "bank_statement_lines" USING btree ("matched_journal_line_id") WHERE "bank_statement_lines"."matched_journal_line_id" is not null;--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_date_idx" ON "bank_statement_lines" USING btree ("account_id","txn_date");