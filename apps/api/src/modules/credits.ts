import { and, eq, sql } from 'drizzle-orm';
import { D, istDate, money } from '@radcore/shared';
import { audit } from '../core/audit';
import { rows, type DB } from '../db/client';
import { creditApplications, invoices, parties } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import type { Ctx } from '../lib/http';

/**
 * Customer credit from returns.
 *
 * When goods come back on an invoice that was already paid, the credit note leaves the customer
 * in credit on that invoice: paid + credited is more than the invoice. That surplus is the pool.
 * It can be set against other invoices of the same customer, never for more than
 *  - the credit note itself,
 *  - what is left in its invoice's pool, and
 *  - the credit the customer really still has in the ledger (so a credit already refunded in
 *    cash cannot be used a second time).
 */
export type Credit = {
  credit_note_id: string; credit_note_no: string; credit_note_date: string; against_invoice_id: string; against_invoice_no: string;
  amount: string; used: string; available: string;
};

type Pool = { invoice_id: string; invoice_no: string; excess: string; used: string };

function pools(tx: DB, where: ReturnType<typeof sql>): Promise<Pool[]> {
  return rows<Pool>(tx, sql`
    select o.invoice_id, o.invoice_no,
           greatest(o.allocated + o.credited - o.grand_total, 0)::numeric(14,2)::text as excess,
           coalesce((select sum(ca.amount) from credit_applications ca join invoices cn on cn.id = ca.credit_note_id
                      where ca.status = 'posted' and cn.against_invoice_id = o.invoice_id), 0)::numeric(14,2)::text as used
      from v_invoice_outstanding o
     where o.credited > 0 and ${where}`);
}

/** Every credit note of a customer with how much of it can still be set against an invoice. */
export async function availableCredits(tx: DB, partyId: string): Promise<Credit[]> {
  const left = new Map((await pools(tx, sql`o.party_id = ${partyId}`)).map((p) => [p.invoice_id, D(p.excess).minus(p.used)]));
  const notes = await rows<Omit<Credit, 'available'>>(tx, sql`
    select cn.id as credit_note_id, cn.invoice_no as credit_note_no, cn.invoice_date as credit_note_date,
           cn.against_invoice_id, orig.invoice_no as against_invoice_no, cn.grand_total::text as amount,
           coalesce((select sum(ca.amount) from credit_applications ca where ca.credit_note_id = cn.id and ca.status = 'posted'), 0)::numeric(14,2)::text as used
      from invoices cn join invoices orig on orig.id = cn.against_invoice_id
     where cn.doc_type = 'credit_note' and cn.status = 'issued' and cn.party_id = ${partyId}
     order by cn.invoice_date, cn.invoice_no`);
  // What the customer is really in credit by: invoices still open, less what the ledger says they owe.
  const [ledger] = await rows<{ open: string; owes: string }>(tx, sql`
    select (select coalesce(sum(outstanding), 0) from v_invoice_outstanding where party_id = ${partyId})::text as open,
           (select coalesce(sum(l.debit) - sum(l.credit), 0) from journal_lines l join accounts a on a.id = l.account_id
             where a.system_key = 'debtors' and l.party_id = ${partyId})::text as owes`);
  let cap = D(ledger!.open).minus(ledger!.owes);
  return notes.map((n) => {
    const pool = left.get(n.against_invoice_id) ?? D(0);
    const own = D(n.amount).minus(n.used);
    let available = [own, pool, cap].reduce((a, b) => (b.lt(a) ? b : a));
    if (available.lt(0)) available = D(0);
    left.set(n.against_invoice_id, pool.minus(available));
    cap = cap.minus(available);
    return { ...n, available: money(available) };
  });
}

/**
 * After anything that can shrink a pool (a receipt cancelled, a credit note cancelled): make
 * sure no invoice has had more credit used from it than it still has. If so, refuse.
 */
export async function assertCreditsCovered(tx: DB, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  const affected = await pools(tx, sql`o.invoice_id in ${invoiceIds}`);
  // An invoice that no longer has any credit note drops out of the pools; its used credit still has to be zero.
  const stray = await rows<{ invoice_no: string }>(tx, sql`
    select distinct orig.invoice_no from credit_applications ca
      join invoices cn on cn.id = ca.credit_note_id join invoices orig on orig.id = cn.against_invoice_id
     where ca.status = 'posted' and orig.id in ${invoiceIds}
       and not exists (select 1 from v_invoice_outstanding o where o.invoice_id = orig.id and o.credited > 0)`);
  const short = affected.find((p) => D(p.used).gt(p.excess));
  const invoiceNo = short?.invoice_no ?? stray[0]?.invoice_no;
  if (invoiceNo) {
    throw conflict(`Credit from the return on ${invoiceNo} has already been used against another invoice. Take that credit back first, on the invoice it was applied to.`);
  }
}

/** Set a credit note's unused credit against another invoice of the same customer. */
export async function applyCredit(ctx: Ctx, invoiceId: string, creditNoteId: string, amount?: string | null) {
  const { tx } = ctx;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  must(inv, 'Invoice');
  if (inv!.docType !== 'tax_invoice' || inv!.status !== 'issued') throw conflict('Credit can only be set against an issued invoice');
  if (!inv!.partyId) throw conflict('This is a cash sale with no customer on it, so there is no credit to use');
  const [cn] = await tx.select().from(invoices).where(eq(invoices.id, creditNoteId)).for('update');
  if (!cn || cn.docType !== 'credit_note' || cn.status !== 'issued') throw badRequest('That is not an issued credit note');
  if (cn.partyId !== inv!.partyId) throw conflict('The credit note belongs to a different customer');
  if (cn.againstInvoiceId === invoiceId) throw conflict(`${cn.invoiceNo} was raised against this invoice and already reduces it`);
  // One at a time per customer, so the same credit cannot be used twice by two people at once.
  await tx.select({ id: parties.id }).from(parties).where(eq(parties.id, inv!.partyId)).for('update');

  const [o] = await rows<{ outstanding: string }>(tx, sql`select outstanding::text from v_invoice_outstanding where invoice_id = ${invoiceId}`);
  const outstanding = D(o?.outstanding ?? 0);
  if (outstanding.lte(0)) throw conflict(`${inv!.invoiceNo} has nothing outstanding`);
  const credit = (await availableCredits(tx, inv!.partyId)).find((c) => c.credit_note_id === creditNoteId);
  const available = D(credit?.available ?? 0);
  if (available.lte(0)) throw conflict(`${cn.invoiceNo} has no unused credit`);
  const use = amount ? D(amount) : (available.lt(outstanding) ? available : outstanding);
  if (use.lte(0)) throw badRequest('The amount must be more than 0');
  if (use.gt(available)) throw conflict(`${cn.invoiceNo} has only ${money(available)} of unused credit`);
  if (use.gt(outstanding)) throw conflict(`${inv!.invoiceNo} has only ${money(outstanding)} outstanding`);

  const [row] = await tx.insert(creditApplications).values({
    creditNoteId, invoiceId, amount: money(use), appliedOn: istDate(), createdBy: ctx.user?.id ?? null,
  }).returning();
  await audit(ctx, 'credit_application', row!.id, 'apply', null, { creditNote: cn.invoiceNo, invoice: inv!.invoiceNo, amount: money(use) });
  return row!;
}

/** Take a credit back off an invoice; it becomes available again. */
export async function unapplyCredit(ctx: Ctx, id: string, why: string): Promise<void> {
  const [row] = await ctx.tx.select().from(creditApplications).where(eq(creditApplications.id, id)).for('update');
  must(row, 'Credit application');
  if (row!.status !== 'posted') throw conflict('This credit has already been taken back');
  await ctx.tx.update(creditApplications).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(creditApplications.id, id));
  await audit(ctx, 'credit_application', id, 'take_back', { status: 'posted', amount: row!.amount }, { status: 'cancelled', why });
}

/** Take back every credit applied to an invoice (used when the invoice itself is cancelled). */
export async function unapplyAllOn(ctx: Ctx, invoiceId: string, why: string): Promise<void> {
  const live = await ctx.tx.select({ id: creditApplications.id }).from(creditApplications)
    .where(and(eq(creditApplications.invoiceId, invoiceId), eq(creditApplications.status, 'posted')));
  for (const a of live) await unapplyCredit(ctx, a.id, why);
}

/** What an invoice's page shows: credit applied to it, credit it could use, and (for a credit note) where its credit went. */
export async function creditsFor(db: DB, invoiceId: string) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  must(inv, 'Invoice');
  const applied = await rows(db, sql`
    select ca.id, ca.amount, ca.applied_on, cn.id as credit_note_id, cn.invoice_no as credit_note_no
      from credit_applications ca join invoices cn on cn.id = ca.credit_note_id
     where ca.invoice_id = ${invoiceId} and ca.status = 'posted' order by ca.created_at`);
  const usedOn = await rows(db, sql`
    select ca.id, ca.amount, ca.applied_on, i.id as invoice_id, i.invoice_no
      from credit_applications ca join invoices i on i.id = ca.invoice_id
     where ca.credit_note_id = ${invoiceId} and ca.status = 'posted' order by ca.created_at`);
  let available: Credit[] = [];
  let outstanding = '0.00';
  if (inv!.docType === 'tax_invoice' && inv!.status === 'issued' && inv!.partyId) {
    const [o] = await rows<{ outstanding: string }>(db, sql`select outstanding::numeric(14,2)::text as outstanding from v_invoice_outstanding where invoice_id = ${invoiceId}`);
    outstanding = o?.outstanding ?? '0.00';
    if (D(outstanding).gt(0)) {
      available = (await availableCredits(db, inv!.partyId)).filter((c) => D(c.available).gt(0) && c.against_invoice_id !== invoiceId);
    }
  }
  return { outstanding, applied, available, used_on: usedOn };
}
