import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, STATE_CODES, istDate, money } from '@radcore/shared';
import { requirePerm } from '../core/auth';
import { getCompany } from '../core/settings';
import { rows, type DB } from '../db/client';
import { badRequest } from '../lib/errors';
import { sendList, zDate } from '../lib/http';

/**
 * GST returns, read straight from the documents: what we charged from issued invoices and credit
 * notes, what we can claim from purchase bills, debit notes and expenses. Nothing is stored for a
 * return, so correcting a document corrects the return.
 *   gstSummary        the GSTR-3B figures for a period
 *   gstr1Sections     GSTR-1, section by section
 *   gstr1PortalFile   GSTR-1 for a month as the file the GST portal accepts
 */

/** B2C invoices above this value to another state are reported invoice-wise (B2CL) in GSTR-1. */
export const B2CL_THRESHOLD = '100000';

// ---------------------------------------------------------------------------
// GSTR-3B: the summary
// ---------------------------------------------------------------------------
type Tax = { taxable: string; igst: string; cgst: string; sgst: string; cess: string };
const zero = (): Tax => ({ taxable: '0.00', igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00' });
const net = (a: Tax, b: Tax): Tax => ({
  taxable: money(D(a.taxable).minus(b.taxable)), igst: money(D(a.igst).minus(b.igst)),
  cgst: money(D(a.cgst).minus(b.cgst)), sgst: money(D(a.sgst).minus(b.sgst)), cess: money(D(a.cess).minus(b.cess)),
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
             coalesce(sum(cgst_total), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst_total), 0)::numeric(16,2)::text as sgst,
             coalesce(sum(cess_total), 0)::numeric(16,2)::text as cess
        from invoices where doc_type = ${docType}::invoice_doc_type and status = 'issued' and invoice_date between ${from}::date and ${to}::date`);
    return r ?? zero();
  };
  const inward = async (docType: 'bill' | 'debit_note') => {
    const [r] = await rows<Tax>(db, sql`
      select coalesce(sum(taxable_total), 0)::numeric(16,2)::text as taxable, coalesce(sum(igst_total), 0)::numeric(16,2)::text as igst,
             coalesce(sum(cgst_total), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst_total), 0)::numeric(16,2)::text as sgst,
             '0.00' as cess
        from purchase_bills where doc_type = ${docType}::bill_doc_type and status = 'posted' and bill_date between ${from}::date and ${to}::date`);
    return r ?? zero();
  };
  const [exp] = await rows<Tax>(db, sql`
    select coalesce(sum(amount) filter (where gst_amount > 0), 0)::numeric(16,2)::text as taxable, coalesce(sum(igst), 0)::numeric(16,2)::text as igst,
           coalesce(sum(cgst), 0)::numeric(16,2)::text as cgst, coalesce(sum(sgst), 0)::numeric(16,2)::text as sgst, '0.00' as cess
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
    cess: money(D(purchaseNet.cess).plus(exp?.cess ?? 0)),
  };
  const outputTax = D(output.igst).plus(output.cgst).plus(output.sgst).plus(output.cess);
  const itcTax = D(itc.igst).plus(itc.cgst).plus(itc.sgst).plus(itc.cess);
  return {
    from, to,
    outward: { sales, sales_returns: salesReturns, net: output, total_tax: money(outputTax) },
    itc: { purchases, purchase_returns: purchaseReturns, expenses: exp ?? zero(), net: itc, total_tax: money(itcTax) },
    // Estimate only: the real set-off order (IGST credit first, etc.) is applied on the portal.
    net_payable: {
      igst: money(D(output.igst).minus(itc.igst)), cgst: money(D(output.cgst).minus(itc.cgst)), sgst: money(D(output.sgst).minus(itc.sgst)),
      cess: money(D(output.cess).minus(itc.cess)), total: money(outputTax.minus(itcTax)),
    },
  };
}

// ---------------------------------------------------------------------------
// GSTR-1, section by section
// ---------------------------------------------------------------------------
/** The GSTR-1 sections for a period, each as a query. `home` is the company's own state code. */
function gstr1Sections(db: DB, from: string, to: string, home: string) {
  const invoiceWise = (b2b: boolean) => rows(db, sql`
    select i.party_gstin as gstin, i.party_name as receiver_name, i.invoice_no, i.invoice_date, i.grand_total as invoice_value,
           i.place_of_supply, il.gst_rate as rate, sum(il.taxable_value) as taxable_value,
           sum(il.igst) as igst, sum(il.cgst) as cgst, sum(il.sgst) as sgst, sum(il.cess) as cess
      from invoices i join invoice_lines il on il.invoice_id = i.id
     where i.doc_type = 'tax_invoice' and i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
       and ${b2b ? sql`i.party_gstin is not null` : sql`i.party_gstin is null and i.place_of_supply <> ${home} and i.grand_total > ${B2CL_THRESHOLD}::numeric`}
     group by i.id, il.gst_rate order by i.invoice_no, il.gst_rate`);

  return {
    b2b: () => invoiceWise(true),
    b2cl: () => invoiceWise(false),
    // Everything else sold to unregistered buyers, summarised by place of supply and rate, net of their credit notes.
    b2cs: () => rows(db, sql`
      select x.place_of_supply, x.rate, sum(x.taxable_value) as taxable_value, sum(x.igst) as igst, sum(x.cgst) as cgst, sum(x.sgst) as sgst,
             sum(x.cess) as cess
        from (
          select i.place_of_supply, il.gst_rate as rate,
                 case when i.doc_type = 'credit_note' then -il.taxable_value else il.taxable_value end as taxable_value,
                 case when i.doc_type = 'credit_note' then -il.igst else il.igst end as igst,
                 case when i.doc_type = 'credit_note' then -il.cgst else il.cgst end as cgst,
                 case when i.doc_type = 'credit_note' then -il.sgst else il.sgst end as sgst,
                 case when i.doc_type = 'credit_note' then -il.cess else il.cess end as cess
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
             sum(il.igst) as igst, sum(il.cgst) as cgst, sum(il.sgst) as sgst, sum(il.cess) as cess
        from invoices i join invoice_lines il on il.invoice_id = i.id join invoices orig on orig.id = i.against_invoice_id
       where i.doc_type = 'credit_note' and i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
         and ${registered
           ? sql`i.party_gstin is not null`
           : sql`i.party_gstin is null and orig.place_of_supply <> ${home} and orig.grand_total > ${B2CL_THRESHOLD}::numeric`}
       group by i.id, orig.invoice_no, orig.invoice_date, il.gst_rate order by i.invoice_no, il.gst_rate`),
    hsn: (registered: boolean | null = null) => rows(db, sql`
      select il.hsn_sac as hsn, il.unit as uqc, il.gst_rate as rate,
             sum(case when i.doc_type = 'credit_note' then -il.qty else il.qty end) as total_qty,
             sum(case when i.doc_type = 'credit_note' then -il.line_total else il.line_total end) as total_value,
             sum(case when i.doc_type = 'credit_note' then -il.taxable_value else il.taxable_value end) as taxable_value,
             sum(case when i.doc_type = 'credit_note' then -il.igst else il.igst end) as igst,
             sum(case when i.doc_type = 'credit_note' then -il.cgst else il.cgst end) as cgst,
             sum(case when i.doc_type = 'credit_note' then -il.sgst else il.sgst end) as sgst,
             sum(case when i.doc_type = 'credit_note' then -il.cess else il.cess end) as cess
        from invoices i join invoice_lines il on il.invoice_id = i.id
       where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
         and (${registered}::boolean is null or (i.party_gstin is not null) = ${registered}::boolean)
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
}

// ---------------------------------------------------------------------------
// GSTR-1 as the file the GST portal accepts
// ---------------------------------------------------------------------------
// The GST portal's unit codes (UQC) for the units RadCore uses; anything else goes as "OTH" (Others).
const UQC: Record<string, string> = {
  nos: 'NOS', pcs: 'PCS', set: 'SET', kg: 'KGS', gm: 'GMS', mtr: 'MTR', ltr: 'LTR', box: 'BOX', pair: 'PRS', roll: 'ROL',
};
const num = (v: unknown) => Number(D(String(v ?? 0)).toFixed(2));
const dmy = (iso: unknown) => { const d = String(iso).slice(0, 10); return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`; };
type Row = Record<string, any>;

/** Tax amounts the way the portal wants them: IGST for another state, CGST + SGST within the state. */
function itemDetail(r: Row, home: string) {
  const base = { txval: num(r.taxable_value), rt: Number(r.rate) };
  return String(r.place_of_supply) === home
    ? { ...base, camt: num(r.cgst), samt: num(r.sgst), csamt: num(r.cess) }
    : { ...base, iamt: num(r.igst), csamt: num(r.cess) };
}
// One item per tax rate on a document; the serial is the rate with "01" after it (18% -> 1801), as the offline tool numbers them.
const item = (r: Row, home: string) => ({ num: Math.round(Number(r.rate) * 100) + 1, itm_det: itemDetail(r, home) });

function groupBy<T>(list: T[], key: (x: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const x of list) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
  return [...map];
}

/**
 * GSTR-1 for one month in the JSON layout the GST portal's "upload offline file" accepts
 * (the same layout its offline tool writes). Sections with nothing to report are left out.
 * Built from the same queries as the on-screen GSTR-1, so the two always agree.
 */
export async function gstr1PortalFile(db: DB, month: string) {
  const { from, to } = period({ month });
  const company = await getCompany(db);
  if (!company.gstin) throw badRequest('Fill in the company GSTIN under Setup before preparing the return');
  const home = company.state_code;
  const s = gstr1Sections(db, from, to, home);
  const file: Record<string, unknown> = { gstin: company.gstin, fp: `${month.slice(5, 7)}${month.slice(0, 4)}`, version: 'GST3.2.2', hash: 'hash' };

  const invoices = (list: Row[]) => groupBy(list, (r) => r.invoice_no).map(([, lines]) => ({
    inum: lines[0]!.invoice_no, idt: dmy(lines[0]!.invoice_date), val: num(lines[0]!.invoice_value), pos: String(lines[0]!.place_of_supply),
    itms: lines.map((l) => item(l, home)),
  }));
  const b2b = groupBy(await s.b2b() as Row[], (r) => String(r.gstin)).map(([ctin, list]) => ({
    ctin, inv: invoices(list).map((i) => ({ ...i, rchrg: 'N', inv_typ: 'R' })),
  }));
  if (b2b.length) file.b2b = b2b;

  const b2cl = groupBy(await s.b2cl() as Row[], (r) => String(r.place_of_supply)).map(([pos, list]) => ({
    pos, inv: invoices(list).map(({ pos: _pos, ...i }) => i),
  }));
  if (b2cl.length) file.b2cl = b2cl;

  const b2cs = (await s.b2cs()).filter((r: Row) => num(r.taxable_value) !== 0).map((r: Row) => ({
    sply_ty: String(r.place_of_supply) === home ? 'INTRA' : 'INTER', pos: String(r.place_of_supply), typ: 'OE', ...itemDetail(r, home),
  }));
  if (b2cs.length) file.b2cs = b2cs;

  const notes = (list: Row[]) => groupBy(list, (r) => r.note_no).map(([, lines]) => ({
    ntty: 'C', nt_num: lines[0]!.note_no, nt_dt: dmy(lines[0]!.note_date), val: num(lines[0]!.note_value), pos: String(lines[0]!.place_of_supply),
    itms: lines.map((l) => item(l, home)),
  }));
  const cdnr = groupBy(await s.creditNotes(true) as Row[], (r) => String(r.gstin)).map(([ctin, list]) => ({
    ctin, nt: notes(list).map((n) => ({ ...n, rchrg: 'N', inv_typ: 'R' })),
  }));
  if (cdnr.length) file.cdnr = cdnr;
  const cdnur = notes(await s.creditNotes(false)).map((n) => ({ typ: 'B2CL', ...n }));
  if (cdnur.length) file.cdnur = cdnur;

  // Table 12 is filed in two parts since 2025: supplies to registered buyers, and everything else.
  const hsn = (list: Row[]) => list.map((r, i) => {
    const service = String(r.hsn).startsWith('99');
    return {
      num: i + 1, hsn_sc: String(r.hsn), desc: '', uqc: service ? 'NA' : (UQC[String(r.uqc).toLowerCase()] ?? 'OTH'),
      qty: service ? 0 : Number(D(String(r.total_qty)).toFixed(3)), txval: num(r.taxable_value), iamt: num(r.igst), camt: num(r.cgst), samt: num(r.sgst), csamt: num(r.cess),
      rt: Number(r.rate),
    };
  });
  const [hsnB2b, hsnB2c] = [hsn(await s.hsn(true)), hsn(await s.hsn(false))];
  if (hsnB2b.length || hsnB2c.length) file.hsn = { hsn_b2b: hsnB2b, hsn_b2c: hsnB2c };

  // Table 13: the portal's own code for each kind of document.
  const DOC_CODES: Record<string, number> = { 'Invoices for outward supply': 1, 'Debit Note': 4, 'Credit Note': 5 };
  const docs = (await s.docs()).map((d: Row) => ({
    doc_num: DOC_CODES[d.document]!, docs: [{ num: 1, from: d.from_no, to: d.to_no, totnum: d.total, cancel: d.cancelled, net_issue: d.net_issued }],
  }));
  if (docs.length) file.doc_issue = { doc_det: docs };
  return file;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
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

  /** The month's GSTR-1 as a file to upload on the GST portal (Returns → GSTR-1 → Prepare offline → Upload). */
  r.get('/gstr1/portal-file', requirePerm('gst:read'), async (req, res) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM') }).parse(req.query);
    const file = await gstr1PortalFile(db, q.month);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="GSTR1_${String(file.gstin)}_${String(file.fp)}.json"`);
    // Sent as written: the portal's key names and number formats must not pass through the API's usual reshaping.
    res.send(JSON.stringify(file));
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
    const sections = gstr1Sections(db, from, to, company.state_code);


    const withState = (list: Record<string, unknown>[]) =>
      list.map((x) => ({ ...x, place_of_supply_name: STATE_CODES[String(x.place_of_supply)] ?? x.place_of_supply }));

    if (q.section) {
      const data =
        q.section === 'cdnr' ? await sections.creditNotes(true)
        : q.section === 'cdnur' ? await sections.creditNotes(false)
        : q.section === 'hsn' ? await sections.hsn() : await sections[q.section]();
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
