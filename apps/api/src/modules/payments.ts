import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, PAYMENT_DIRECTIONS, PAYMENT_MODES, istDate, money, round2, type PaymentMode } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { assertMoneyAccount, defaultMoneyAccount, postJournal, reverseJournals, type SystemAccount } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { rows, type DB } from '../db/client';
import { invoices, parties, paymentAllocations, payments, purchaseBills, tdsRates } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import {
  emptyToNull, fxOf, inTx, sendList, zCurrency, zDate, zFxRate, zId, zListQuery, zMoney, zMoneyPos, zText, type Ctx,
} from '../lib/http';
import { assertCreditsCovered } from './credits';

/**
 * Payments: money received from customers and paid to suppliers.
 *
 * A payment is set against invoices (money in) or purchase bills (money out). Whatever is not set
 * against anything stays on the party's account as an advance and can be allocated later. Tax held
 * back at source (TDS) is recorded on the payment and settles the party just as the money does.
 * Cancelling writes the mirror entry in the books and frees what had been allocated.
 */

export type Payment = typeof payments.$inferSelect;
export type AllocationInput = { invoiceId?: string | null; purchaseBillId?: string | null; amount: string };

export type PaymentInput = {
  direction: 'in' | 'out';
  partyId: string | null;
  mode: PaymentMode;
  accountId?: string | null;
  amount: string;
  reference?: string | null;
  paidOn: string;
  notes?: string | null;
  allocations?: AllocationInput[];
  /** Tax held back on top of `amount`: by us from a supplier, or by the customer from us. */
  tdsAmount?: string | null;
  tdsRateId?: string | null;
  /** What the tax was worked out on; the whole settlement when not given. */
  tdsBase?: string | null;
  /** Paid in a foreign currency (to a supplier): which, and its rate in rupees today. */
  currency?: string;
  fxRate?: string | null;
};

/** What a payment settles on the party's account: the money that moved plus any tax held back. */
export const settles = (p: { amount: string; tdsAmount: string }) => D(p.amount).plus(p.tdsAmount);

/** Which control account a party's money sits in: customers/dealers -> Debtors, suppliers -> Creditors. */
function controlAccount(partyType: string | null): SystemAccount {
  return partyType === 'supplier' ? 'creditors' : 'debtors';
}

/**
 * Allocate part of a payment to invoices (money in) or purchase bills (money out).
 * Each target row is locked, so two payments can never both settle the same rupee.
 */
async function allocate(ctx: Ctx, payment: Payment, allocations: AllocationInput[]): Promise<void> {
  const { tx } = ctx;
  let fxTotal = D(0);
  for (const a of allocations) {
    const amount = D(a.amount);
    if (amount.lte(0)) throw badRequest('Allocation amount must be more than 0');
    if (a.invoiceId) {
      if (payment.direction !== 'in') throw badRequest('Only money received can be allocated to a sales invoice');
      if (payment.currency !== 'INR') throw badRequest('Sales invoices are in rupees: record the receipt in INR');
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, a.invoiceId)).for('update');
      if (!inv || inv.docType !== 'tax_invoice' || inv.status !== 'issued') throw badRequest('Invoice is not an issued tax invoice');
      if ((inv.partyId ?? null) !== (payment.partyId ?? null)) throw badRequest(`Invoice ${inv.invoiceNo} belongs to a different party`);
      const [o] = await rows<{ outstanding: string }>(tx, sql`select outstanding from v_invoice_outstanding where invoice_id = ${inv.id}`);
      if (amount.gt(D(o?.outstanding ?? 0))) {
        throw conflict(`Invoice ${inv.invoiceNo} has only ${money(o?.outstanding ?? 0)} outstanding`);
      }
      await tx.insert(paymentAllocations).values({ paymentId: payment.id, invoiceId: inv.id, amount: money(amount), createdBy: ctx.user?.id ?? null });
    } else if (a.purchaseBillId) {
      if (payment.direction !== 'out') throw badRequest('Only money paid out can be allocated to a purchase bill');
      const [bill] = await tx.select().from(purchaseBills).where(eq(purchaseBills.id, a.purchaseBillId)).for('update');
      if (!bill || bill.docType !== 'bill' || bill.status !== 'posted') throw badRequest('Purchase bill is not a posted bill');
      if (bill.supplierId !== payment.partyId) throw badRequest(`Bill ${bill.billNo} belongs to a different supplier`);
      if (bill.currency !== payment.currency) throw badRequest(`Bill ${bill.billNo} is in ${bill.currency}: pay it in ${bill.currency}`);
      const [o] = await rows<{ outstanding: string }>(tx, sql`select outstanding from v_bill_outstanding where bill_id = ${bill.id}`);
      const outstanding = D(o?.outstanding ?? 0);
      // A foreign bill is cleared by the foreign sum paid, at the bill's own rate; the rupees paid were at today's.
      // The difference is the exchange gain (+) or loss (-). A paisa or so of rounding on the last payment is absorbed.
      let cleared = bill.currency === 'INR' ? amount : round2(amount.div(payment.fxRate).times(bill.fxRate));
      if (cleared.gt(outstanding) && cleared.minus(outstanding).lte(1) && bill.currency !== 'INR') cleared = outstanding;
      if (cleared.gt(outstanding)) {
        throw conflict(`Bill ${bill.billNo} has only ${money(outstanding)} outstanding`);
      }
      const fxDifference = cleared.minus(amount);
      fxTotal = fxTotal.plus(fxDifference);
      await tx.insert(paymentAllocations).values({
        paymentId: payment.id, purchaseBillId: bill.id, amount: money(amount), fxDifference: money(fxDifference), createdBy: ctx.user?.id ?? null,
      });
    } else throw badRequest('Each allocation needs an invoice or a purchase bill');
  }
  const [t] = await rows<{ total: string }>(tx, sql`
    select coalesce(sum(amount), 0)::text as total from payment_allocations where payment_id = ${payment.id}`);
  if (D(t?.total ?? 0).gt(settles(payment))) throw badRequest('Allocations add up to more than the payment');
  // The exchange difference settles the supplier for more (a gain) or less (a loss) than the rupees paid.
  // Booked under the payment, so cancelling the payment reverses it with the rest.
  if (!fxTotal.isZero()) {
    await postJournal(ctx, {
      date: payment.paidOn, refType: 'payment', refId: payment.id, entityId: payment.entityId,
      narration: `Exchange ${fxTotal.gt(0) ? 'gain' : 'loss'} on ${payment.paymentNo} (${payment.currency} at ${D(payment.fxRate).toString()})`,
      lines: [{ account: 'creditors', partyId: payment.partyId, debit: fxTotal }, { account: 'forex_gain_loss', credit: fxTotal }],
    });
  }
}

/**
 * Payment in or out (PRD 7.8 / 8.9). Posts Dr Cash/Bank - Cr party (in) or the reverse (out),
 * and allocates across invoices/bills. Whatever is left unallocated is an advance.
 *
 * With TDS the party is settled for more than the money that moved. Paying a supplier 9,000 with
 * 1,000 held back: Dr Creditors 10,000 - Cr Bank 9,000 - Cr TDS Payable 1,000. A customer paying
 * 9,000 after holding back 1,000: Dr Bank 9,000 - Dr TDS Receivable 1,000 - Cr Debtors 10,000.
 */
export async function createPayment(ctx: Ctx, input: PaymentInput): Promise<Payment> {
  const { tx } = ctx;
  let partyType: string | null = null;
  let partyName = 'Cash sale';
  if (input.partyId) {
    const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
    if (!party) throw badRequest('Party not found');
    partyType = party.partyType;
    partyName = party.name;
  } else {
    // No party: only a counter sale paid in full on the spot (PRD 8.9).
    const allocated = (input.allocations ?? []).reduce((a, x) => a.plus(x.amount), D(0));
    if (input.direction !== 'in' || !allocated.eq(D(input.amount))) {
      throw badRequest('A payment without a party must be fully allocated to a cash-sale invoice');
    }
  }
  const tds = D(input.tdsAmount ?? 0);
  let tdsRate: typeof tdsRates.$inferSelect | undefined;
  if (tds.gt(0)) {
    if (!input.partyId) throw badRequest('TDS needs a named party');
    if (input.direction === 'out' && partyType !== 'supplier') throw badRequest('TDS is held back from payments to suppliers');
    if (input.tdsRateId) {
      [tdsRate] = await tx.select().from(tdsRates).where(eq(tdsRates.id, input.tdsRateId));
      if (!tdsRate || !tdsRate.active) throw badRequest('Pick the kind of payment the TDS is for');
    } else if (input.direction === 'out') {
      // What we hold back has to be reported under its head; what a customer held back is theirs to report.
      throw badRequest('Pick the kind of payment the TDS is for');
    }
  } else if (input.tdsRateId) throw badRequest('Enter the TDS amount, or leave the kind of payment blank');
  const settled = D(input.amount).plus(tds);
  const tdsBase = tds.gt(0) ? D(input.tdsBase ?? settled) : null;
  if (tdsBase && (tdsBase.lte(0) || tds.gte(tdsBase))) throw badRequest('The TDS must be less than the amount it is worked out on');
  const accountId = input.accountId ?? (await defaultMoneyAccount(tx, input.mode));
  await assertMoneyAccount(tx, accountId);
  const fx = fxOf(input.currency ?? 'INR', input.fxRate);
  if (fx.currency !== 'INR' && input.direction !== 'out') throw badRequest('Money received is recorded in rupees');

  const { number } = await nextNumber(tx, input.direction === 'in' ? 'receipt' : 'payment_out', input.paidOn);
  const [payment] = await tx
    .insert(payments)
    .values({
      paymentNo: number,
      direction: input.direction,
      partyId: input.partyId,
      mode: input.mode,
      accountId,
      amount: money(input.amount),
      currency: fx.currency,
      fxRate: fx.fxRate,
      tdsAmount: money(tds),
      tdsRateId: tds.gt(0) ? (tdsRate?.id ?? null) : null,
      tdsBase: tdsBase ? money(tdsBase) : null,
      reference: input.reference ?? null,
      paidOn: input.paidOn,
      notes: input.notes ?? null,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();
  if (input.allocations?.length) await allocate(ctx, payment!, input.allocations);

  const control = controlAccount(partyType);
  await postJournal(ctx, {
    date: input.paidOn,
    refType: 'payment',
    refId: payment!.id,
    narration: `${input.direction === 'in' ? 'Received from' : 'Paid to'} ${partyName} (${number}, ${input.mode})${tds.gt(0) ? `, TDS ${money(tds)}` : ''}`,
    lines:
      input.direction === 'in'
        ? [{ account: { id: accountId }, debit: input.amount }, { account: 'tds_receivable', debit: tds }, { account: control, partyId: input.partyId, credit: settled }]
        : [{ account: control, partyId: input.partyId, debit: settled }, { account: { id: accountId }, credit: input.amount }, { account: 'tds_payable_vendors', credit: tds }],
  });
  await audit(ctx, 'payment', payment!.id, 'create', null, { ...payment, allocations: input.allocations ?? [] });
  return payment!;
}

/** Cancel a payment: its entry is reversed and its allocations stop counting, so the invoices or bills it paid are owed again. */
export async function cancelPayment(ctx: Ctx, id: string, reason: string): Promise<Payment> {
  const { tx } = ctx;
  const [payment] = await tx.select().from(payments).where(eq(payments.id, id)).for('update');
  must(payment, 'Payment');
  if (payment!.status === 'cancelled') throw conflict('Payment is already cancelled');
  // Its allocations stop counting the moment the status flips (the outstanding views ignore cancelled payments).
  const [updated] = await tx.update(payments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(payments.id, id)).returning();
  // If this receipt is what put the customer in credit on an invoice with a return, that credit must not have been spent.
  const paidFor = await rows<{ invoice_id: string }>(tx, sql`
    select distinct invoice_id from payment_allocations where payment_id = ${id} and invoice_id is not null`);
  await assertCreditsCovered(tx, paidFor.map((r) => r.invoice_id));
  await reverseJournals(ctx, 'payment', id, istDate(), `Cancelled ${payment!.paymentNo}: ${reason}`);
  await audit(ctx, 'payment', id, 'cancel', { status: 'posted' }, { status: 'cancelled', reason });
  return updated!;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function paymentsRouter(db: DB) {
  const r = Router();

  r.get('/', requirePerm('payments:read'), async (req, res) => {
    const q = zListQuery.extend({
      direction: z.enum(PAYMENT_DIRECTIONS).optional(), party_id: zId.optional(), from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const data = await rows(db, sql`
      select p.*, pt.name as party_name, a.name as account_name,
             coalesce(al.allocated, 0) as allocated,
             case when p.status = 'posted' then p.amount + p.tds_amount - coalesce(al.allocated, 0) else 0 end as unallocated,
             t.name as tds_rate_name
        from payments p
        left join parties pt on pt.id = p.party_id
        left join tds_rates t on t.id = p.tds_rate_id
        join accounts a on a.id = p.account_id
        left join (select payment_id, sum(amount) as allocated from payment_allocations group by payment_id) al on al.payment_id = p.id
       where (${q.direction ?? null}::text is null or p.direction::text = ${q.direction ?? null})
         and (${q.party_id ?? null}::uuid is null or p.party_id = ${q.party_id ?? null}::uuid)
         and (${q.from ?? null}::date is null or p.paid_on >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or p.paid_on <= ${q.to ?? null}::date)
       order by p.paid_on desc, p.created_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'payments', { limit: q.limit });
  });

  r.get('/:id', requirePerm('payments:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [payment] = await rows(db, sql`
      select p.*, pt.name as party_name, a.name as account_name, t.name as tds_rate_name, t.rate as tds_rate
        from payments p left join parties pt on pt.id = p.party_id join accounts a on a.id = p.account_id
        left join tds_rates t on t.id = p.tds_rate_id
       where p.id = ${id}`);
    must(payment, 'Payment');
    const allocations = await rows(db, sql`
      select pa.id, pa.amount, pa.fx_difference, pa.invoice_id, i.invoice_no, pa.purchase_bill_id, b.bill_no, b.supplier_invoice_no
        from payment_allocations pa
        left join invoices i on i.id = pa.invoice_id
        left join purchase_bills b on b.id = pa.purchase_bill_id
       where pa.payment_id = ${id}`);
    res.json({ data: { ...payment, allocations } });
  });

  const zAlloc = z.object({
    invoice_id: emptyToNull(zId).optional(), purchase_bill_id: emptyToNull(zId).optional(), amount: zMoneyPos,
  });
  const toAlloc = (a: z.infer<typeof zAlloc>): AllocationInput => ({
    invoiceId: a.invoice_id ?? null, purchaseBillId: a.purchase_bill_id ?? null, amount: a.amount,
  });

  r.post('/', requirePerm('payments:write'), async (req, res) => {
    const b = z.object({
      direction: z.enum(PAYMENT_DIRECTIONS),
      party_id: zId,
      mode: z.enum(PAYMENT_MODES),
      account_id: emptyToNull(zId).optional(),
      amount: zMoneyPos,
      reference: emptyToNull(z.string().trim().max(100)).optional(),
      paid_on: zDate.default(() => istDate()),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
      allocations: z.array(zAlloc).max(200).default([]),
      tds_amount: emptyToNull(zMoney).optional(),
      tds_rate_id: emptyToNull(zId).optional(),
      tds_base: emptyToNull(zMoneyPos).optional(),
      currency: zCurrency, fx_rate: emptyToNull(zFxRate).optional(),
    }).parse(req.body);
    const payment = await inTx(db, req, (ctx) =>
      createPayment(ctx, {
        direction: b.direction, partyId: b.party_id, mode: b.mode, accountId: b.account_id, amount: b.amount,
        reference: b.reference, paidOn: b.paid_on, notes: b.notes, allocations: b.allocations.map(toAlloc),
        tdsAmount: b.tds_amount, tdsRateId: b.tds_rate_id, tdsBase: b.tds_base, currency: b.currency, fxRate: b.fx_rate,
      }));
    res.status(201).json({ data: payment });
  });

  /** Use an advance later: allocate the unallocated part of a payment. */
  r.post('/:id/allocate', requirePerm('payments:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ allocations: z.array(zAlloc).min(1).max(200) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const [payment] = await ctx.tx.select().from(payments).where(eq(payments.id, id)).for('update');
      must(payment, 'Payment');
      if (payment!.status !== 'posted') throw conflict('Payment is cancelled');
      await allocate(ctx, payment!, b.allocations.map(toAlloc));
      await audit(ctx, 'payment', id, 'allocate', null, b.allocations);
    });
    res.json({ ok: true });
  });

  r.post('/:id/cancel', requirePerm('payments:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => cancelPayment(ctx, id, b.reason)) });
  });
  return r;
}
