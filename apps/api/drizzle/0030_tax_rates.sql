-- GST rate history (P1): the rate (and cess, BCD, SWS) for an HSN from a date on; a document line takes the rate on its date.
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hsn" text NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"cess_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"bcd_rate" numeric(5, 2),
	"sws_rate" numeric(5, 2),
	"effective_from" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "tax_rates_hsn_from_uq" UNIQUE("hsn","effective_from"),
	CONSTRAINT "tax_rates_gst_rate_chk" CHECK ("tax_rates"."gst_rate" in (0, 0.25, 3, 5, 12, 18, 28, 40)),
	CONSTRAINT "tax_rates_hsn_chk" CHECK ("tax_rates"."hsn" ~ '^[0-9]{2,8}$')
);
