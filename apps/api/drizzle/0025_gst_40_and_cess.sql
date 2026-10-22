-- GST at 40% (and the 0.25% and 3% special rates), and compensation cess on items, order lines, invoice lines and invoices.
ALTER TABLE "items" DROP CONSTRAINT "items_gst_rate_chk";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cess_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cess" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cess_total" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "cess_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "cess_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cess_rate_chk" CHECK ("items"."cess_rate" >= 0);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_gst_rate_chk" CHECK ("items"."gst_rate" in (0, 0.25, 3, 5, 12, 18, 28, 40));