-- Unexpected errors kept for System health and the alert channel (technical review, 26 Oct 2026).
CREATE TABLE "error_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"detail" text,
	"user_id" uuid
);
--> statement-breakpoint
CREATE INDEX "error_log_at_idx" ON "error_log" USING btree ("at");