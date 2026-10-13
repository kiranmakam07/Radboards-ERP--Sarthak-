import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { formatDate, formatINR } from '@radcore/shared';
import { config } from '../config';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { getCompany } from '../core/settings';
import { rows, type DB } from '../db/client';
import { invoiceLinks, parties, paymentReminders } from '../db/schema';
import { badRequest, must } from '../lib/errors';
import { inTx, zId } from '../lib/http';
import { invoiceDocument, shareTokenFor } from './sales';

/**
 * Getting paid: the bill sent to the customer as a link they can open, and reminders for what is
 * still owed. Both go out by WhatsApp from the person's own phone or computer, with the message
 * already written; what was sent, and when, is kept so nobody is reminded twice in a day by mistake.
 */

type Due = { id: string; invoice_no: string; invoice_date: string; due_date: string | null; outstanding: string; days_overdue: number };

/** What each customer owes, invoice by invoice, with how late it is and when they were last reminded. */
export async function whoOwes(db: DB, partyId?: string) {
  return rows<{
    party_id: string; party_name: string; phone: string | null; total: string; overdue: string; invoices: Due[];
    last_reminded_at: string | null; reminders_sent: number;
  }>(db, sql`
    select p.id as party_id, p.name as party_name, p.phone,
           sum(o.outstanding)::numeric(14,2)::text as total,
           coalesce(sum(o.outstanding) filter (where o.due_date < (now() at time zone 'Asia/Kolkata')::date), 0)::numeric(14,2)::text as overdue,
           json_agg(json_build_object(
             'id', o.invoice_id, 'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date, 'due_date', o.due_date, 'outstanding', o.outstanding::text,
             'days_overdue', greatest(0, (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, i.invoice_date)))
             order by coalesce(o.due_date, i.invoice_date), i.invoice_no) as invoices,
           (select max(r.created_at) from payment_reminders r where r.party_id = p.id) as last_reminded_at,
           (select count(*)::int from payment_reminders r where r.party_id = p.id) as reminders_sent
      from v_invoice_outstanding o join invoices i on i.id = o.invoice_id join parties p on p.id = o.party_id
     where o.outstanding > 0 and (${partyId ?? null}::uuid is null or p.id = ${partyId ?? null}::uuid)
     group by p.id order by sum(o.outstanding) filter (where o.due_date < (now() at time zone 'Asia/Kolkata')::date) desc nulls last, sum(o.outstanding) desc`);
}

/** The reminder as it will be sent: polite, exact, and with a link to each bill (the first five). */
export function reminderText(v: { name: string; company: string; total: string; invoices: (Due & { link: string | null })[]; upi?: string | null }): string {
  const lines = v.invoices.slice(0, 5).map((i) =>
    `${i.invoice_no} of ${formatDate(i.invoice_date)}: ₹${formatINR(i.outstanding)}${i.days_overdue > 0 && i.due_date ? ` (was due ${formatDate(i.due_date)})` : ''}${i.link ? `\n${i.link}` : ''}`);
  const more = v.invoices.length > 5 ? [`and ${v.invoices.length - 5} more`] : [];
  return [
    `Dear ${v.name},`,
    `A gentle reminder from ${v.company}: ₹${formatINR(v.total)} is pending.`,
    ...lines, ...more,
    v.upi ? `You can pay by UPI to ${v.upi}.` : null,
    'Please ignore this if you have already paid. Thank you.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function collectRouter(db: DB) {
  const r = Router();

  r.get('/reminders', requirePerm('payments:read'), async (_req, res) => {
    res.json({ data: await whoOwes(db) });
  });

  /** Write the reminder for one customer, note that it was sent, and hand back the WhatsApp link that opens it. */
  r.post('/reminders/:partyId', requirePerm('payments:write'), async (req, res) => {
    const partyId = zId.parse(req.params.partyId);
    // The address people use to reach the app, which is not always the one this request arrived on (it may come through a proxy).
    const origin = config.webOrigin.split(',')[0]!.trim();
    const out = await inTx(db, req, async (ctx) => {
      const [party] = await ctx.tx.select().from(parties).where(eq(parties.id, partyId));
      must(party, 'Party');
      const [owed] = await whoOwes(ctx.tx, partyId);
      if (!owed) throw badRequest(`${party!.name} does not owe anything`);
      if (!party!.phone) throw badRequest(`${party!.name} has no phone number. Add one on their page first.`);
      const company = await getCompany(ctx.tx);
      const listed = [];
      for (const [n, i] of owed.invoices.entries()) listed.push({ ...i, link: n < 5 ? `${origin}/i/${await shareTokenFor(ctx, i.id)}` : null });
      const text = reminderText({ name: party!.name, company: company.name, total: owed.total, invoices: listed, upi: company.bank?.upi_id ?? null });
      await ctx.tx.insert(paymentReminders).values({ partyId, amount: owed.total, invoiceIds: owed.invoices.map((i) => i.id), message: text, createdBy: ctx.user!.id });
      await audit(ctx, 'party', partyId, 'payment_reminder', null, { amount: owed.total, invoices: owed.invoices.length });
      return { text, phone: party!.phone, total: owed.total };
    });
    res.status(201).json({ data: { ...out, whatsapp_url: `https://wa.me/${out.phone.replace(/\D/g, '')}?text=${encodeURIComponent(out.text)}` } });
  });

  return r;
}

/** The bill as the customer sees it: the document itself and what is still to pay, nothing internal (no costs, no notes). */
export function publicInvoiceRouter(db: DB) {
  const r = Router();
  r.get('/:token', async (req, res) => {
    const [found] = await db.select({ id: invoiceLinks.invoiceId }).from(invoiceLinks).where(eq(invoiceLinks.token, String(req.params.token)));
    if (!found) throw must(null, 'This link');
    const doc = await invoiceDocument(db, found.id);
    const { lines, payment, hsn_summary, company, against_invoice, amount_in_words, place_of_supply_name, is_inter_state, is_b2b } = doc;
    res.json({
      data: {
        doc_type: doc.docType, invoice_no: doc.invoiceNo, invoice_date: doc.invoiceDate, due_date: doc.dueDate, status: doc.status, reason: doc.reason,
        place_of_supply: doc.placeOfSupply, tax_inclusive: doc.taxInclusive, party_name: doc.partyName, party_gstin: doc.partyGstin, party_phone: doc.partyPhone,
        billing_address: doc.billingAddress, shipping_address: doc.shippingAddress, taxable_total: doc.taxableTotal, cgst_total: doc.cgstTotal,
        sgst_total: doc.sgstTotal, igst_total: doc.igstTotal, round_off: doc.roundOff, grand_total: doc.grandTotal,
        lines: lines.map((l) => ({
          id: l.id, description: l.description, hsn_sac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discount: l.discount,
          taxable_value: l.taxableValue, gst_rate: l.gstRate, line_total: l.lineTotal,
        })),
        hsn_summary, company, against_invoice: against_invoice ? { invoice_no: (against_invoice as any).invoice_no, invoice_date: (against_invoice as any).invoice_date } : null,
        amount_in_words, place_of_supply_name, is_inter_state, is_b2b,
        payment: payment ? { outstanding: (payment as any).outstanding, payment_status: (payment as any).payment_status } : null,
      },
    });
  });
  return r;
}
