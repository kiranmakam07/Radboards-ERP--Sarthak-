-- GST returns marked as filed (technical review, 26 Oct 2026): a filed month is closed for the documents its return reports.
CREATE TABLE "gst_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_type" text NOT NULL,
	"period" char(7) NOT NULL,
	"filed_on" date NOT NULL,
	"arn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "gst_filings_return_chk" CHECK ("gst_filings"."return_type" in ('gstr1', 'gstr3b')),
	CONSTRAINT "gst_filings_period_chk" CHECK ("gst_filings"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gst_filings_uq" ON "gst_filings" USING btree ("return_type","period");