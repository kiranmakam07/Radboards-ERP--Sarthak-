CREATE TABLE "tds_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"paid_on" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"account_id" uuid NOT NULL,
	"month" char(7) NOT NULL,
	"challan_no" text,
	"bsr_code" text,
	"notes" text,
	"status" "posted_status" DEFAULT 'posted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "tds_deposits_amount_pos" CHECK ("tds_deposits"."amount" > 0),
	CONSTRAINT "tds_deposits_kind_chk" CHECK ("tds_deposits"."kind" in ('vendor', 'salary'))
);
--> statement-breakpoint
CREATE TABLE "tds_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"law_reference" text,
	"return_code" text,
	"rate" numeric(5, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "tds_rates_name_unique" UNIQUE("name"),
	CONSTRAINT "tds_rates_rate_chk" CHECK ("tds_rates"."rate" > 0 and "tds_rates"."rate" <= 100)
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "tds_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "tds_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "vendor_pan" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "pan" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_base" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "tds_deposits" ADD CONSTRAINT "tds_deposits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tds_rate_id_tds_rates_id_fk" FOREIGN KEY ("tds_rate_id") REFERENCES "public"."tds_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tds_rate_id_tds_rates_id_fk" FOREIGN KEY ("tds_rate_id") REFERENCES "public"."tds_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tds_chk" CHECK ("expenses"."tds_amount" >= 0 and "expenses"."tds_amount" <= "expenses"."amount");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tds_chk" CHECK ("payments"."tds_amount" >= 0);