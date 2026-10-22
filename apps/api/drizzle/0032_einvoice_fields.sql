-- E-invoice fields (P1): IRN acknowledgement, signed QR, IRN status and cancellation, e-way bill validity; RC004 lets an issued (or cancelled) invoice take these and nothing else.
ALTER TABLE "invoices" ADD COLUMN "irn_ack_no" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "irn_ack_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "signed_qr" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "irn_status" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "irn_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "eway_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_irn_status_chk" CHECK ("invoices"."irn_status" is null or "invoices"."irn_status" in ('generated', 'cancelled', 'failed'));--> statement-breakpoint
-- RC004, rewritten: an issued invoice may still be cancelled and have its e-invoice and e-way bill
-- references set; a cancelled one may still have its IRN cancellation recorded. Nothing else changes.
CREATE OR REPLACE FUNCTION rc_invoice_immutable() RETURNS trigger AS $$
DECLARE
  einvoice text[] := ARRAY['irn', 'irn_ack_no', 'irn_ack_date', 'signed_qr', 'irn_status', 'irn_cancelled_at', 'eway_bill_no', 'eway_valid_until', 'updated_at'];
  mutable text[] := einvoice || ARRAY['status', 'cancelled_at', 'cancel_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'invoice % is a legal record and cannot be deleted', OLD.invoice_no USING ERRCODE = 'RC004';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    IF (to_jsonb(NEW) - einvoice) IS DISTINCT FROM (to_jsonb(OLD) - einvoice) THEN
      RAISE EXCEPTION 'cancelled invoice % cannot change', OLD.invoice_no USING ERRCODE = 'RC004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'draft' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'issued invoice % is immutable', OLD.invoice_no USING ERRCODE = 'RC004';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
