import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, STATE_CODES, istDate, money } from '@radcore/shared';
import { requirePerm } from '../core/auth';
import { getCompany } from '../core/settings';
import { rows, type DB } from '../db/client';
import { badRequest } from '../lib/errors';
import { sendList, zDate } from '../lib/http';

/** B2C invoices above this value to another state are reported invoice-wise (B2CL) in GSTR-1. */
export const B2CL_THRESHOLD = '100000';

type Tax = { taxable: string; igst: string; cgst: string; sgst: string };
const zero = (): Tax => ({ taxable: '0.00', igst: '0.00', cgst: '0.00', sgst: '0.00' });
const net = (a: Tax, b: Tax): Tax => ({
  taxable: money(D(a.taxable).minus(b.taxable)), igst: money(D(a.igst).minus(b.igst)),
  cgst: money(D(a.cgst).minus(b.cgst)), sgst: money(D(a.sgst).minus(b.sgst)),
});

/**
 * GSTR-3B style summary for a period (PRD 7.9 / 8.12 gst_summary):
 * output tax (invoices less credit notes), input tax credit (purchase bills less debit
 * notes, plus GST on expenses) and the net payable per tax head.
 */
export async function gstSummary(db: DB, from: string, to: string) {
  const outward = async (docType: 'tax_invoice' | 'credit_note') => {
    const [r] = await rows<Tax>(db, sql`
      select coalesce(sum(taxable_total), 0)::numeric(16,2)::text as taxable, coalesce(sum(igst_total), 0)::numeric(16,2)::text as igst,
             coalesce(sum(cgst_total), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst_total), 0)::numeric(16,2)::text as sgst
        from invoices where doc_type = ${docType}::invoice_doc_type and status = 'issued' and invoice_date between ${from}::date and ${to}::date`);
    return r ?? zero();
  };
  const inward = async (docType: 'bill' | 'debit_note') => {
    const [r] = await rows<Tax>(db, sql`
      select coalesce(sum(taxable_total), 0)::numeric(16,2)::text as taxable, coalesce(sum(igst_total), 0)::numeric(16,2)::text as igst,
             coalesce(sum(cgst_total), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst_total), 0)::numeric(16,2)::text as sgst
        from purchase_bills where doc_type = ${docType}::bill_doc_type and status = 'posted' and bill_date between ${from}::date and ${to}::date`);
    return r ?? zero();
  };
  const [exp] = await rows<Tax>(db, sql`
    select coalesce(sum(amount) filter (where gst_amount > 0), 0)::numeric(16,2)::text as taxable, coalesce(sum(igst), 0)::numeric(16,2)::text as igst,
           coalesce(sum(cgst), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst), 0)::numeric(16,2)::text as sgst
      from expenses where status = 'posted' and expense_date between ${from}::date and ${to}::date`);

  const sales = await outward('tax_invoice');
  const salesReturns = await outward('credit_note');
  const purchases = await inward('bill');
  const purchaseReturns = await inward('debit_note');
  const output = net(sales, salesReturns);
  const purchaseNet = net(purchases, purchaseReturns);
  const itc: Tax = {
    taxable: money(D(purchaseNet.taxable).plus(exp?.taxable ?? 0)), igst: money(D(purchaseNet.igst).plus(exp?.igst ?? 0)),
    cgst: money(D(purchaseNet.cgst).plus(exp?.cgst ?? 0)), sgst: money(D(purchaseNet.sgst).plus(exp?.sgst ?? 0)),
  };
  const outputTax = D(output.igst).plus(output.cgst).plus(output.sgst);
  const itcTax = D(itc.igst).plus(itc.cgst).plus(itc.sgst);
  return {
    from, to,
    outward: { sales, sales_returns: salesReturns, net: output, total_tax: money(outputTax) },
    itc: { purchases, purchase_returns: purchaseReturns, expenses: exp ?? zero(), net: itc, total_tax: money(itcTax) },
    // Estimate only: the real set-off order (IGST credit first, etc.) is applied on the portal.
    net_payable: {
      igst: money(D(output.igst).minus(itc.igst)), cgst: money(D(output.cgst).minus(itc.cgst)), sgst: money(D(output.sgst).minus(itc.sgst)),
      total: money(outputTax.minus(itcTax)),
    },
  };
}

function period(q: { month?: string; from?: string; to?: string }): { from: string; to: string } {
  if (q.from && q.to) return { from: q.from, to: q.to };
  const month = q.month ?? istDate().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const zPeriod = z.object({ month: z.string().optional(), from: zDate.optional(), to: zDate.optional() });

export function gstRouter(db: DB) {
  const r = Router();

  r.get('/gstr3b', requirePerm('gst:read'), async (req, res) => {
    const p = period(zPeriod.parse(req.query));
    res.json({ data: await gstSummary(db, p.from, p.to) });
  });

  /**
   * GSTR-1 sections for a period. JSON by default; ?section=b2b&format=csv exports one
   * section for the offline tool. Layouts follow the portal's sections - have the CA check
   * the first real filing against the portal before relying on it.
   */
  r.get('/gstr1', requirePerm('gst:read'), async (req, res) => {
    const q = zPeriod.extend({ section: z.enum(['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'hsn', 'docs']).optional() }).parse(req.query);
    const { from, to } = period(q);
    const company = await getCompany(db);
    const home = company.state_code;

    const invoiceWise = (b2b: boolean) => rows(db, sql`
      select i.party_gstin as gstin, i.party_name as receiver_name, i.invoice_no, i.invoice_date, i.grand_total as invoice_value,
             i.place_of_supply, il.gst_rate as rate, sum(il.taxable_value) as taxable_value,
             sum(il.igst) as igst, sum(il.cgst) as cgst, sum(il.sgst) as sgst
        from invoices i join invoice_lines il on il.invoice_id = i.id
       where i.doc_type = 'tax_invoice' and i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
         and ${b2b ? sql`i.party_gstin is not null` : sql`i.party_gstin is null and i.place_of_supply <> ${home} and i.grand_total > ${B2CL_THRESHOLD}::numeric`}
       group by i.id, il.gst_rate order by i.invoice_no, il.gst_rate`);

    const sections = {
      b2b: () => invoiceWise(true),
      b2cl: () => invoiceWise(false),
      // Everything else sold to unregistered buyers, summarised by place of supply and rate, net of their credit notes.
      b2cs: () => rows(db, sql`
        select x.place_of_supply, x.rate, sum(x.taxable_value) as taxable_value, sum(x.igst) as igst, sum(x.cgst) as cgst, sum(x.sgst) as sgst
          from (
            select i.place_of_supply, il.gst_rate as rate,
                   case when i.doc_type = 'credit_note' then -il.taxable_value else il.taxable_value end as taxable_value,
                   case when i.doc_type = 'credit_note' then -il.igst else il.igst end as igst,
                   case when i.doc_type = 'credit_note' then -il.cgst else il.cgst end as cgst,
                   case when i.doc_type = 'credit_note' then -il.sgst else il.sgst end as sgst
              from invoices i join invoice_lines il on il.invoice_id = i.id
              left join invoices orig on orig.id = i.against_invoice_id
             where i.status = 'issued' and i.party_gstin is null and i.invoice_date between ${from}::date and ${to}::date
               and not (coalesce(orig.place_of_supply, i.place_of_supply) <> ${home}
                        and coalesce(orig.grand_total, i.grand_total) > ${B2CL_THRESHOLD}::numeric)
          ) x
         group by x.place_of_supply, x.rate order by x.place_of_supply, x.rate`),
      creditNotes: (registered: boolean) => rows(db, sql`
        select i.party_gstin as gstin, i.party_name as receiver_name, i.invoice_no as note_no, i.invoice_date as note_date, 'C' as note_type,
               orig.invoice_no as original_invoice_no, orig.invoice_date as original_invoice_date, i.grand_total as note_value,
               i.place_of_supply, il.gst_rate as rate, sum(il.taxable_value) as taxable_value,
               sum(il.igst) as igst, sum(il.cgst) as cgst, sum(il.sgst) as sgst
          from invoices i join invoice_lines il on il.invoice_id = i.id join invoices orig on orig.id = i.against_invoice_id
         where i.doc_type = 'credit_note' and i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
           and ${registered
             ? sql`i.party_gstin is not null`
             : sql`i.party_gstin is null and orig.place_of_supply <> ${home} and orig.grand_total > ${B2CL_THRESHOLD}::numeric`}
         group by i.id, orig.invoice_no, orig.invoice_date, il.gst_rate order by i.invoice_no, il.gst_rate`),
      hsn: () => rows(db, sql`
        select il.hsn_sac as hsn, il.unit as uqc, il.gst_rate as rate,
               sum(case when i.doc_type = 'credit_note' then -il.qty else il.qty end) as total_qty,
               sum(case when i.doc_type = 'credit_note' then -il.line_total else il.line_total end) as total_value,
               sum(case when i.doc_type = 'credit_note' then -il.taxable_value else il.taxable_value end) as taxable_value,
               sum(case when i.doc_type = 'credit_note' then -il.igst else il.igst end) as igst,
               sum(case when i.doc_type = 'credit_note' then -il.cgst else il.cgst end) as cgst,
               sum(case when i.doc_type = 'credit_note' then -il.sgst else il.sgst end) as sgst
          from invoices i join invoice_lines il on il.invoice_id = i.id
         where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
         group by il.hsn_sac, il.unit, il.gst_rate order by il.hsn_sac, il.gst_rate`),
      // Documents issued: every number used in the period, including cancelled ones (numbers are never reused).
      docs: () => rows(db, sql`
        select 'Invoices for outward supply' as document, min(invoice_no) as from_no, max(invoice_no) as to_no, count(*)::int as total,
               count(*) filter (where status = 'cancelled')::int as cancelled, count(*) filter (where status = 'issued')::int as net_issued
          from invoices where doc_type = 'tax_invoice' and status <> 'draft' and invoice_date between ${from}::date and ${to}::date
        having count(*) > 0
        union all
        select 'Credit Note', min(invoice_no), max(invoice_no), count(*)::int, count(*) filter (where status = 'cancelled')::int,
               count(*) filter (where status = 'issued')::int
          from invoices where doc_type = 'credit_note' and status <> 'draft' and invoice_date between ${from}::date and ${to}::date
        having count(*) > 0
        union all
        select 'Debit Note', min(bill_no), max(bill_no), count(*)::int, count(*) filter (where status = 'cancelled')::int,
               count(*) filter (where status = 'posted')::int
          from purchase_bills where doc_type = 'debit_note' and bill_date between ${from}::date and ${to}::date
        having count(*) > 0`),
    };

    const withState = (list: Record<string, unknown>[]) =>
      list.map((x) => ({ ...x, place_of_supply_name: STATE_CODES[String(x.place_of_supply)] ?? x.place_of_supply }));

    if (q.section) {
      const data =
        q.section === 'cdnr' ? await sections.creditNotes(true)
        : q.section === 'cdnur' ? await sections.creditNotes(false)
        : await sections[q.section]();
      return sendList(req, res, q.section === 'hsn' || q.section === 'docs' ? data : withState(data), `gstr1-${q.section}-${from.slice(0, 7)}`);
    }
    res.json({
      data: {
        gstin: company.gstin, from, to,
        b2b: withState(await sections.b2b()), b2cl: withState(await sections.b2cl()), b2cs: withState(await sections.b2cs()),
        cdnr: withState(await sections.creditNotes(true)), cdnur: withState(await sections.creditNotes(false)),
        hsn: await sections.hsn(), docs: await sections.docs(),
      },
    });
  });
  return r;
}
