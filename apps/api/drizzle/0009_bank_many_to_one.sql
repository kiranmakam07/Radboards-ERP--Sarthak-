CREATE TABLE "bank_line_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"journal_line_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_line_matches_journal_line_id_unique" UNIQUE("journal_line_id")
);
--> statement-breakpoint
-- Carry the existing one-to-one matches over before their column is dropped.
INSERT INTO "bank_line_matches" ("statement_line_id", "journal_line_id", "created_at")
  SELECT "id", "matched_journal_line_id", coalesce("matched_at", now())
    FROM "bank_statement_lines" WHERE "matched_journal_line_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" DROP CONSTRAINT "bank_statement_lines_match_chk";--> statement-breakpoint
ALTER TABLE "bank_statement_lines" DROP CONSTRAINT "bank_statement_lines_matched_journal_line_id_journal_lines_id_fk";
--> statement-breakpoint
DROP INDEX "bank_statement_lines_match_uq";--> statement-breakpoint
ALTER TABLE "bank_line_matches" ADD CONSTRAINT "bank_line_matches_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_matches" ADD CONSTRAINT "bank_line_matches_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_line_matches_statement_idx" ON "bank_line_matches" USING btree ("statement_line_id");--> statement-breakpoint
ALTER TABLE "bank_statement_lines" DROP COLUMN "matched_journal_line_id";