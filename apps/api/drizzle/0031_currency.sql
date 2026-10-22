-- Currency (P1): supplier documents and payments can be in a foreign currency at a rate in rupees; a foreign bill paid at another rate books the difference to Foreign Exchange Gain / Loss.
ALTER TABLE "payment_allocations" ADD COLUMN "fx_difference" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" char(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fx_rate" numeric(12, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "currency" char(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD COLUMN "fx_rate" numeric(12, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "currency" char(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "fx_rate" numeric(12, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fx_rate_pos" CHECK ("payments"."fx_rate" > 0);--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_fx_rate_pos" CHECK ("purchase_bills"."fx_rate" > 0);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_fx_rate_pos" CHECK ("purchase_orders"."fx_rate" > 0);--> statement-breakpoint
-- A bill is cleared by what was paid plus the exchange difference on it.
CREATE OR REPLACE VIEW v_bill_outstanding AS
  SELECT b.id AS bill_id,
         b.supplier_id,
         b.bill_no,
         b.supplier_invoice_no,
         b.bill_date,
         b.due_date,
         b.grand_total,
         coalesce(a.allocated, 0) AS allocated,
         coalesce(dn.debited, 0) AS debited,
         greatest(b.grand_total - coalesce(a.allocated, 0) - coalesce(dn.debited, 0), 0) AS outstanding,
         CASE
           WHEN b.grand_total - coalesce(a.allocated, 0) - coalesce(dn.debited, 0) <= 0 THEN 'paid'
           WHEN coalesce(a.allocated, 0) + coalesce(dn.debited, 0) > 0 THEN 'partly_paid'
           ELSE 'unpaid'
         END AS payment_status
    FROM purchase_bills b
    LEFT JOIN (
      SELECT pa.purchase_bill_id, sum(pa.amount + pa.fx_difference) AS allocated
        FROM payment_allocations pa
        JOIN payments p ON p.id = pa.payment_id AND p.status = 'posted'
       WHERE pa.purchase_bill_id IS NOT NULL
       GROUP BY pa.purchase_bill_id
    ) a ON a.purchase_bill_id = b.id
    LEFT JOIN (
      SELECT against_bill_id, sum(grand_total) AS debited
        FROM purchase_bills
       WHERE doc_type = 'debit_note' AND status = 'posted' AND against_bill_id IS NOT NULL
       GROUP BY against_bill_id
    ) dn ON dn.against_bill_id = b.id
   WHERE b.doc_type = 'bill' AND b.status = 'posted';
