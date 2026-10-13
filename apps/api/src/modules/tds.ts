import { asc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, addMonths, formatDate, fyOf, fyRange, istDate, money } from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { assertMoneyAccount, postJournal, reverseJournals, systemAccountIds, type SystemAccount } from '../core/journal';
import { rows, type DB } from '../db/client';
import { accounts, tdsDeposits, tdsRates } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zMoneyPos, zText, wantsFile, type Ctx } from '../lib/http';

/**
 * TDS (tax deducted at source), both ways round.
 *
 * - What we hold back when paying a supplier or an expense is owed to the government (TDS Payable).
 *   It is recorded on the payment or the expense itself; this module reports it and records its
 *   deposit.
 * - What a customer holds back when paying us is tax already paid on our behalf (TDS Receivable).
 *   It is recorded on the receipt; this module lists it, to be checked against the tax statement.
 */

const PAYABLE: Record<'vendor' | 'salary', SystemAccount> = { vendor: 'tds_payable_vendors', salary: 'tds_payable' };
const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** TDS held back in a month is due by the 7th of the next month; March's is due by 30 April. */
export const tdsDueOn = (month: string): string => (month.endsWith('-03') ? `${month.slice(0, 4)}-04-30` : `${addMonths(`${month}-01`, 1).slice(0, 7)}-07`);

/** What an account holds as of a date, in its natural direction (a liability's credits less its debits). */
async function balanceOf(tx: DB, key: SystemAccount, side: 'credit' | 'debit', asOf: string | null = null): Promise<string> {
  const [r] = await rows<{ balance: string }>(tx, sql`
    select coalesce(sum(l.credit - l.debit), 0)::numeric(16,2)::text as balance
      from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
     where a.system_key = ${key} and (${asOf}::date is null or e.entry_date <= ${asOf}::date)`);
  return money(side === 'credit' ? D(r?.balance ?? 0) : D(r?.balance ?? 0).neg());
}

/** The period a report covers: the dates given, or the financial year so far. */
function span(q: { from?: string; to?: string }): { from: string; to: string } {
  const today = istDate();
  const from = q.from ?? fyRange(fyOf(today)).from;
  const to = q.to ?? today;
  if (from > to) throw badRequest('The first date is after the last');
  return { from, to };
}

type Deduction = {
  source: 'payment' | 'expense'; id: string; doc_no: string; date: string; deductee: string; pan: string | null;
  kind: string | null; law_reference: string | null; return_code: string | null; rate: string | null; base: string; tds: string;
};

/** Every amount we held back in a period, from supplier payments and from expenses. */
export function deductions(db: DB, from: string, to: string): Promise<Deduction[]> {
  return rows<Deduction>(db, sql`
    select x.* from (
      select 'payment' as source, p.id, p.payment_no as doc_no, p.paid_on as date, pt.name as deductee,
             coalesce(pt.pan, substring(pt.gstin from 3 for 10)) as pan,
             t.name as kind, t.law_reference, t.return_code, t.rate::text as rate, p.tds_base::text as base, p.tds_amount::text as tds
        from payments p join parties pt on pt.id = p.party_id left join tds_rates t on t.id = p.tds_rate_id
       where p.direction = 'out' and p.status = 'posted' and p.tds_amount > 0 and p.paid_on between ${from}::date and ${to}::date
      union all
      select 'expense', e.id, e.expense_no, e.expense_date, e.vendor_name,
             coalesce(e.vendor_pan, substring(e.vendor_gstin from 3 for 10)),
             t.name, t.law_reference, t.return_code, t.rate::text, e.amount::text, e.tds_amount::text
        from expenses e left join tds_rates t on t.id = e.tds_rate_id
       where e.status = 'posted' and e.tds_amount > 0 and e.expense_date between ${from}::date and ${to}::date
    ) x order by x.date, x.doc_no`);
}

export async function recordDeposit(
  ctx: Ctx,
  input: { kind: 'vendor' | 'salary'; paidOn: string; amount: string; accountId: string; month: string; challanNo?: string | null; bsrCode?: string | null; notes?: string | null },
) {
  const { tx } = ctx;
  if (input.month > input.paidOn.slice(0, 7)) throw badRequest('That month has not ended yet');
  await assertMoneyAccount(tx, input.accountId);
  const key = PAYABLE[input.kind];
  // One deposit at a time against the liability, so two cannot both pay the same rupee.
  const ids = await systemAccountIds(tx, [key]);
  await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, ids[key]!)).for('update');
  const owed = D(await balanceOf(tx, key, 'credit'));
  if (D(input.amount).gt(owed)) {
    throw conflict(owed.gt(0)
      ? `Only ${money(owed)} of TDS is owed. A deposit cannot be more than that.`
      : 'No TDS is owed at the moment, so there is nothing to deposit.');
  }
  const [deposit] = await tx.insert(tdsDeposits).values({
    kind: input.kind, paidOn: input.paidOn, amount: money(input.amount), accountId: input.accountId, month: input.month,
    challanNo: input.challanNo ?? null, bsrCode: input.bsrCode ?? null, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
  }).returning();
  await postJournal(ctx, {
    date: input.paidOn, refType: 'tds_deposit', refId: deposit!.id,
    narration: `TDS paid to the government, ${input.kind === 'salary' ? 'salaries' : 'vendors'}, ${monthName(input.month)}${input.challanNo ? ` (challan ${input.challanNo})` : ''}`,
    lines: [{ account: key, debit: input.amount }, { account: { id: input.accountId }, credit: input.amount }],
  });
  await audit(ctx, 'tds_deposit', deposit!.id, 'create', null, deposit);
  return deposit!;
}

export function tdsRouter(db: DB) {
  const r = Router();

  // ---- the kinds of payment and their rates ----
  r.get('/rates', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(tdsRates).orderBy(asc(tdsRates.name)), 'tds-rates');
  });

  const zRate = z.object({
    name: zText(120),
    law_reference: emptyToNull(z.string().trim().max(120)).optional(),
    return_code: emptyToNull(z.string().trim().max(20)).optional(),
    rate: z.coerce.number().gt(0).max(100).transform((n) => n.toFixed(2)),
    active: z.boolean().optional(),
  });
  r.post('/rates', requirePerm('accounts:write'), async (req, res) => {
    const b = zRate.parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [clash] = await rows(ctx.tx, sql`select 1 as x from tds_rates where lower(name) = lower(${b.name})`);
      if (clash) throw conflict(`There is already a rate called ${b.name}`);
      const [created] = await ctx.tx.insert(tdsRates)
        .values({ name: b.name, lawReference: b.law_reference ?? null, returnCode: b.return_code ?? null, rate: b.rate, createdBy: ctx.user!.id }).returning();
      await audit(ctx, 'tds_rate', created!.id, 'create', null, created);
      return created;
    });
    res.status(201).json({ data: row });
  });
  /** Changing a rate affects what is offered from now on; deductions already recorded keep their own figure. */
  r.patch('/rates/:id', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zRate.partial().parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(tdsRates).where(eq(tdsRates.id, id)).for('update');
      must(before, 'TDS rate');
      const [after] = await ctx.tx.update(tdsRates).set({
        name: b.name, lawReference: b.law_reference, returnCode: b.return_code, rate: b.rate, active: b.active, updatedAt: new Date(),
      }).where(eq(tdsRates.id, id)).returning();
      await audit(ctx, 'tds_rate', id, 'update', before, after);
      return after;
    });
    res.json({ data: row });
  });

  // ---- what we held back, and what has been paid over ----
  r.get('/payable', requirePerm('accounts:read'), async (req, res) => {
    const { from, to } = span(z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query));
    const data = await deductions(db, from, to);
    if (wantsFile(req)) return sendList(req, res, data.map(({ id: _id, ...x }) => x), `tds-deducted-${from}-to-${to}`);
    const total = (list: Deduction[], k: 'base' | 'tds') => money(list.reduce((s, x) => s.plus(x[k]), D(0)));

    const kinds = [...new Set(data.map((x) => x.kind ?? 'Not said'))].sort();
    const paid = await rows<{ month: string; deposited: string }>(db, sql`
      select month, sum(amount)::numeric(14,2)::text as deposited from tds_deposits
       where kind = 'vendor' and status = 'posted' and month between ${from.slice(0, 7)} and ${to.slice(0, 7)} group by month`);
    const months = [...new Set([...data.map((x) => String(x.date).slice(0, 7)), ...paid.map((p) => p.month)])].sort();
    const today = istDate();
    res.json({
      data, from, to,
      by_kind: kinds.map((kind) => {
        const list = data.filter((x) => (x.kind ?? 'Not said') === kind);
        return { kind, rate: list[0]!.rate, law_reference: list[0]!.law_reference, return_code: list[0]!.return_code, entries: list.length, base: total(list, 'base'), tds: total(list, 'tds') };
      }),
      by_month: months.map((month) => {
        const deducted = total(data.filter((x) => String(x.date).slice(0, 7) === month), 'tds');
        const deposited = paid.find((p) => p.month === month)?.deposited ?? '0.00';
        const left = D(deducted).minus(deposited);
        const due_on = tdsDueOn(month);
        return { month, deducted, deposited, left: money(left), due_on, overdue: left.gt(0) && due_on < today };
      }),
      totals: { base: total(data, 'base'), tds: total(data, 'tds'), deposited: money(paid.reduce((s, p) => s.plus(p.deposited), D(0))) },
      // What the books say is owed right now, whatever period is on screen.
      owed_now: { vendor: await balanceOf(db, 'tds_payable_vendors', 'credit'), salary: await balanceOf(db, 'tds_payable', 'credit') },
    });
  });

  // ---- what customers held back from us ----
  r.get('/receivable', requirePerm('accounts:read'), async (req, res) => {
    const { from, to } = span(z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query));
    const data = await rows<{ customer: string; gross: string; received: string; tds: string }>(db, sql`
      select p.id, p.payment_no as receipt_no, p.paid_on as date, pt.id as party_id, pt.name as customer,
             coalesce(pt.pan, substring(pt.gstin from 3 for 10)) as pan, pt.gstin, t.name as kind,
             (select string_agg(i.invoice_no, ', ' order by i.invoice_no)
                from payment_allocations pa join invoices i on i.id = pa.invoice_id where pa.payment_id = p.id) as invoices,
             (p.amount + p.tds_amount)::numeric(14,2)::text as gross, p.amount::text as received, p.tds_amount::text as tds
        from payments p join parties pt on pt.id = p.party_id left join tds_rates t on t.id = p.tds_rate_id
       where p.direction = 'in' and p.status = 'posted' and p.tds_amount > 0 and p.paid_on between ${from}::date and ${to}::date
       order by p.paid_on, p.payment_no`);
    if (wantsFile(req)) return sendList(req, res, data.map(({ id: _id, party_id: _p, ...x }: any) => x), `tds-held-back-by-customers-${from}-to-${to}`);
    const total = (list: typeof data, k: 'gross' | 'received' | 'tds') => money(list.reduce((s, x) => s.plus(x[k]), D(0)));
    const customers = [...new Set(data.map((x) => x.customer))].sort();
    res.json({
      data, from, to,
      by_customer: customers.map((customer) => {
        const list = data.filter((x) => x.customer === customer);
        return { customer, pan: (list[0] as any).pan, receipts: list.length, gross: total(list, 'gross'), tds: total(list, 'tds') };
      }),
      totals: { gross: total(data, 'gross'), received: total(data, 'received'), tds: total(data, 'tds') },
      // Tax already paid for us and not yet set against our own income tax.
      balance_now: await balanceOf(db, 'tds_receivable', 'debit'),
    });
  });

  // ---- paying it over ----
  r.get('/deposits', requirePerm('accounts:read'), async (req, res) => {
    sendList(req, res, await rows(db, sql`
      select d.*, a.name as account_name from tds_deposits d join accounts a on a.id = d.account_id
       order by d.paid_on desc, d.created_at desc limit 500`), 'tds-deposits');
  });

  r.post('/deposits', requirePerm('accounts:write'), async (req, res) => {
    const b = z.object({
      kind: z.enum(['vendor', 'salary']).default('vendor'), paid_on: zDate.default(() => istDate()), amount: zMoneyPos, account_id: zId, month: zMonth,
      challan_no: emptyToNull(z.string().trim().max(40)).optional(), bsr_code: emptyToNull(z.string().trim().max(20)).optional(),
      notes: emptyToNull(z.string().trim().max(500)).optional(),
    }).parse(req.body);
    const deposit = await inTx(db, req, (ctx) => recordDeposit(ctx, {
      kind: b.kind, paidOn: b.paid_on, amount: b.amount, accountId: b.account_id, month: b.month, challanNo: b.challan_no, bsrCode: b.bsr_code, notes: b.notes,
    }));
    res.status(201).json({ data: deposit });
  });

  r.post('/deposits/:id/cancel', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    const deposit = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(tdsDeposits).where(eq(tdsDeposits.id, id)).for('update');
      must(row, 'Deposit');
      if (row!.status !== 'posted') throw conflict('This deposit is already cancelled');
      const [updated] = await ctx.tx.update(tdsDeposits).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(tdsDeposits.id, id)).returning();
      await reverseJournals(ctx, 'tds_deposit', id, istDate(), `Cancelled TDS deposit of ${formatDate(row!.paidOn)}: ${b.reason}`);
      await audit(ctx, 'tds_deposit', id, 'cancel', { status: 'posted' }, { status: 'cancelled', reason: b.reason });
      return updated;
    });
    res.json({ data: deposit });
  });
  return r;
}
