-- Database-level guarantees (PRD section 9, "Data integrity"). The API enforces all of
-- these too; the triggers are the backstop so a bug or a manual query cannot break them.

-- 1. Append-only ledgers -----------------------------------------------------
CREATE FUNCTION rc_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RC001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION rc_block_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION rc_block_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION rc_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION rc_block_mutation();
--> statement-breakpoint

-- 2. Double entry: sum(debit) = sum(credit) per entry, checked at COMMIT -------
CREATE FUNCTION rc_check_journal_balanced() RETURNS trigger AS $$
DECLARE
  d numeric;
  c numeric;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO d, c
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is not balanced: debit % <> credit %', NEW.entry_id, d, c
      USING ERRCODE = 'RC002';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rc_check_journal_balanced();
--> statement-breakpoint

-- 3. Period lock: nothing can be posted on or before the lock date -------------
CREATE FUNCTION rc_check_period_lock() RETURNS trigger AS $$
DECLARE
  lock_date date;
BEGIN
  SELECT nullif(value #>> '{}', '')::date INTO lock_date FROM settings WHERE key = 'period_lock_date';
  IF lock_date IS NOT NULL AND NEW.entry_date <= lock_date THEN
    RAISE EXCEPTION 'period is locked up to %: cannot post an entry dated %', lock_date, NEW.entry_date
      USING ERRCODE = 'RC003';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_period_lock BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION rc_check_period_lock();
--> statement-breakpoint

-- 4. Issued invoices are immutable (only cancellation / e-invoice refs may change) -
CREATE FUNCTION rc_invoice_immutable() RETURNS trigger AS $$
DECLARE
  mutable text[] := ARRAY['status', 'cancelled_at', 'cancel_reason', 'irn', 'eway_bill_no', 'updated_at'];
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
    RAISE EXCEPTION 'cancelled invoice % cannot change', OLD.invoice_no USING ERRCODE = 'RC004';
  END IF;
  IF NEW.status = 'draft' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'issued invoice % is immutable', OLD.invoice_no USING ERRCODE = 'RC004';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION rc_invoice_immutable();
--> statement-breakpoint
CREATE FUNCTION rc_invoice_lines_immutable() RETURNS trigger AS $$
DECLARE
  parent_status invoice_status;
  parent_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN parent_id := OLD.invoice_id; ELSE parent_id := NEW.invoice_id; END IF;
  SELECT status INTO parent_status FROM invoices WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of an issued invoice are immutable' USING ERRCODE = 'RC004';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION rc_invoice_lines_immutable();
--> statement-breakpoint

-- 5. Computed views (PRD 8.12) - running figures are derived, never stored -----
CREATE VIEW v_stock_on_hand AS
  SELECT item_id, location_id, sum(qty) AS qty
    FROM stock_movements
   GROUP BY item_id, location_id;
--> statement-breakpoint
CREATE VIEW v_item_valuation AS
  SELECT item_id,
         sum(qty) AS qty,
         sum(value) AS value,
         CASE WHEN sum(qty) > 0 THEN round(sum(value) / sum(qty), 2) END AS avg_cost
    FROM stock_movements
   GROUP BY item_id;
--> statement-breakpoint
CREATE VIEW v_party_balances AS
  SELECT jl.party_id, sum(jl.debit) - sum(jl.credit) AS balance
    FROM journal_lines jl
   WHERE jl.party_id IS NOT NULL
   GROUP BY jl.party_id;
--> statement-breakpoint
CREATE VIEW v_invoice_outstanding AS
  SELECT i.id AS invoice_id,
         i.party_id,
         i.invoice_no,
         i.invoice_date,
         i.due_date,
         i.channel,
         i.grand_total,
         coalesce(a.allocated, 0) AS allocated,
         coalesce(cn.credited, 0) AS credited,
         greatest(i.grand_total - coalesce(a.allocated, 0) - coalesce(cn.credited, 0), 0) AS outstanding,
         CASE
           WHEN i.grand_total - coalesce(a.allocated, 0) - coalesce(cn.credited, 0) <= 0 THEN 'paid'
           WHEN coalesce(a.allocated, 0) + coalesce(cn.credited, 0) > 0 THEN 'partly_paid'
           ELSE 'unpaid'
         END AS payment_status
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
   WHERE i.doc_type = 'tax_invoice' AND i.status = 'issued';
--> statement-breakpoint
CREATE VIEW v_bill_outstanding AS
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
      SELECT pa.purchase_bill_id, sum(pa.amount) AS allocated
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
