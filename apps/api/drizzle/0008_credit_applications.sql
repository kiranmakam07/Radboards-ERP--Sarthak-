CREATE TABLE "credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"applied_on" date NOT NULL,
	"status" "posted_status" DEFAULT 'posted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "credit_applications_amount_chk" CHECK ("credit_applications"."amount" > 0),
	CONSTRAINT "credit_applications_distinct_chk" CHECK ("credit_applications"."credit_note_id" <> "credit_applications"."invoice_id")
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_applications_cn_idx" ON "credit_applications" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "credit_applications_invoice_idx" ON "credit_applications" USING btree ("invoice_id");--> statement-breakpoint
-- An invoice's outstanding amount now also comes down by credit notes applied to it from other invoices.
CREATE OR REPLACE VIEW v_invoice_outstanding AS
  SELECT i.id AS invoice_id,
         i.party_id,
         i.invoice_no,
         i.invoice_date,
         i.due_date,
         i.channel,
         i.grand_total,
         coalesce(a.allocated, 0) AS allocated,
         coalesce(cn.credited, 0) AS credited,
         greatest(i.grand_total - coalesce(a.allocated, 0) - coalesce(cn.credited, 0) - coalesce(ca.applied, 0), 0) AS outstanding,
         CASE
           WHEN i.grand_total - coalesce(a.allocated, 0) - coalesce(cn.credited, 0) - coalesce(ca.applied, 0) <= 0 THEN 'paid'
           WHEN coalesce(a.allocated, 0) + coalesce(cn.credited, 0) + coalesce(ca.applied, 0) > 0 THEN 'partly_paid'
           ELSE 'unpaid'
         END AS payment_status,
         coalesce(ca.applied, 0) AS credit_applied
    FROM invoices i
    LEFT JOIN (
      SELECT pa.invoice_id, sum(pa.amount) AS allocated
        FROM payment_allocations pa
        JOIN payments p ON p.id = pa.payment_id AND p.status = 'posted'
       WHERE pa.invoice_id IS NOT NULL
       GROUP BY pa.invoice_id
    ) a ON a.invoice_id = i.id
    LEFT JOIN (
      SELECT against_invoice_id, sum(grand_total) AS credited
        FROM invoices
       WHERE doc_type = 'credit_note' AND status = 'issued' AND against_invoice_id IS NOT NULL
       GROUP BY against_invoice_id
    ) cn ON cn.against_invoice_id = i.id
    LEFT JOIN (
      SELECT invoice_id, sum(amount) AS applied
        FROM credit_applications
       WHERE status = 'posted'
       GROUP BY invoice_id
    ) ca ON ca.invoice_id = i.id
   WHERE i.doc_type = 'tax_invoice' AND i.status = 'issued';
