import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES, D, addDays, formatDate, fyOf, fyRange, isValidGstin, istDate, money, normaliseGstin } from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { assertMoneyAccount, postJournal, reverseJournals, type JLine } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { accounts, expenseCategories, expenses, fiscalCloses, journalEntries } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zLink, zId, zListQuery, zMoney, zMoneyPos, zText, wantsFile, type Ctx } from '../lib/http';

/**
 * Expense (PRD 7.8): Dr expense account - Dr Input GST (when claimable) - Cr the cash/bank
 * account it was paid from.
 */
export async function createExpense(
  ctx: Ctx,
  input: {
    expenseDate: string; categoryId: string; amount: string; gstAmount?: string | null; gstType: 'none' | 'intra' | 'inter';
    paidFromAccountId: string; vendorName?: string | null; vendorGstin?: string | null; attachmentUrl?: string | null; notes?: string | null;
  },
) {
  const { tx } = ctx;
  const [category] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, input.categoryId));
  if (!category || !category.active) throw badRequest('Expense category not found');
  await assertMoneyAccount(tx, input.paidFromAccountId);
  const gst = input.gstType === 'none' ? D(0) : D(input.gstAmount ?? 0);
  if (input.gstType !== 'none' && gst.lte(0)) throw badRequest('Enter the GST amount, or choose "No GST"');
  // Intra-state input tax is half CGST, half SGST; an odd paisa goes to SGST.
  const cgst = input.gstType === 'intra' ? gst.div(2).toDecimalPlaces(2, 1) : D(0);
  const sgst = input.gstType === 'intra' ? gst.minus(cgst) : D(0);
  const igst = input.gstType === 'inter' ? gst : D(0);
  const total = D(input.amount).plus(gst);

  const { number } = await nextNumber(tx, 'expense', input.expenseDate);
  const [expense] = await tx
    .insert(expenses)
    .values({
      expenseNo: number, expenseDate: input.expenseDate, categoryId: category.id, amount: money(input.amount),
      cgst: money(cgst), sgst: money(sgst), igst: money(igst), gstAmount: money(gst), paidFromAccountId: input.paidFromAccountId,
      vendorName: input.vendorName ?? null, vendorGstin: input.vendorGstin ?? null, attachmentUrl: input.attachmentUrl ?? null,
      notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await postJournal(ctx, {
    date: input.expenseDate, refType: 'expense', refId: expense!.id,
    narration: `${category.name}${input.vendorName ? ` - ${input.vendorName}` : ''} (${number})`,
    lines: [
      { account: { id: category.accountId }, debit: input.amount },
      { account: 'input_cgst', debit: cgst },
      { account: 'input_sgst', debit: sgst },
      { account: 'input_igst', debit: igst },
      { account: { id: input.paidFromAccountId }, credit: total },
    ],
  });
  await audit(ctx, 'expense', expense!.id, 'create', null, expense);
  return expense!;
}

/** Signed balance of each account for a period, in the account's natural direction. */
type AccountTotal = { id: string; code: string; name: string; type: (typeof ACCOUNT_TYPES)[number]; debit: string; credit: string };

/**
 * `withClosing` decides whether year-end closing entries count. A balance as of a date includes
 * them (that is how a closed year's profit sits in Retained Earnings); what was earned and spent
 * in a period leaves them out (otherwise a closed year would always show zero).
 */
async function accountTotals(db: DB, from: string | null, to: string | null, withClosing = true): Promise<AccountTotal[]> {
  return rows<AccountTotal>(db, sql`
    select a.id, a.code, a.name, a.type,
           coalesce(sum(l.debit), 0)::numeric(16,2)::text as debit, coalesce(sum(l.credit), 0)::numeric(16,2)::text as credit
      from accounts a
      left join (
        select jl.account_id, jl.debit, jl.credit from journal_lines jl join journal_entries e on e.id = jl.entry_id
         where (${from}::date is null or e.entry_date >= ${from}::date) and (${to}::date is null or e.entry_date <= ${to}::date)
           and (${withClosing} or e.ref_type <> 'year_close')
      ) l on l.account_id = a.id
     where not a.is_group
     group by a.id order by a.code`);
}

// ---------------------------------------------------------------------------
// Year-end close
// ---------------------------------------------------------------------------
const isFy = (fy: string) => /^\d{4}-\d{2}$/.test(fy) && fyOf(fyRange(fy).from) === fy;

/**
 * Year-end entries are dated on the last day of the year, which is normally already locked.
 * They are the one kind of posting that belongs there, so the lock is stepped back for this
 * transaction only and put back before it ends; nobody else ever sees it moved.
 */
async function insideLockedPeriod<T>(ctx: Ctx, date: string, fn: () => Promise<T>): Promise<T> {
  const lock = await getSetting(ctx.tx, 'period_lock_date');
  if (!lock || date > lock) return fn();
  await setSetting(ctx.tx, 'period_lock_date', addDays(date, -1), ctx.user?.id ?? null);
  const result = await fn();
  await setSetting(ctx.tx, 'period_lock_date', lock, ctx.user?.id ?? null);
  return result;
}

/** Income, expense and profit of a period, leaving closing entries out. */
async function profitOf(db: DB, from: string, to: string) {
  const totals = await accountTotals(db, from, to, false);
  const income = totals.filter((a) => a.type === 'income').reduce((s, a) => s.plus(a.credit).minus(a.debit), D(0));
  const expense = totals.filter((a) => a.type === 'expense').reduce((s, a) => s.plus(a.debit).minus(a.credit), D(0));
  return { income, expense, profit: income.minus(expense) };
}

/** Income and expense accounts that still carry a balance on a date (closing entries counted). */
async function openResultAccounts(db: DB, asOf: string) {
  return (await accountTotals(db, null, asOf)).filter((a) => (a.type === 'income' || a.type === 'expense') && !D(a.debit).eq(a.credit));
}

/**
 * Close a financial year (PRD 7.8): one journal entry on its last day empties every income and
 * expense account into Retained Earnings, so the new year's profit starts from zero. Years are
 * closed in order, only after they have ended, and the books are then locked up to that day.
 */
export async function closeYear(ctx: Ctx, fy: string) {
  const { tx } = ctx;
  if (!isFy(fy)) throw badRequest('Give the financial year as 2026-27');
  const { from, to } = fyRange(fy);
  // One close at a time, and no posting can slip in between reading the balances and locking.
  await tx.execute(sql`select 1 from settings where key = 'period_lock_date' for update`);
  if (to >= istDate()) throw conflict(`${fy} ends on ${formatDate(to)}. It can be closed from the day after.`);
  const [already] = await tx.select().from(fiscalCloses).where(eq(fiscalCloses.fy, fy));
  if (already) throw conflict(`${fy} is already closed`);
  if ((await openResultAccounts(tx, addDays(from, -1))).length > 0) {
    throw conflict(`An earlier year still has income or expenses that were never closed. Close the years in order, oldest first.`);
  }

  const year = await profitOf(tx, from, to);
  const [close] = await tx.insert(fiscalCloses).values({
    fy, fromDate: from, toDate: to, income: money(year.income), expense: money(year.expense), profit: money(year.profit),
    createdBy: ctx.user?.id ?? null,
  }).returning();

  const balances = await openResultAccounts(tx, to);
  // Each account gets the mirror of its balance; what is left over is the year's profit (or loss).
  const lines: JLine[] = balances.map((a) => ({ account: { id: a.id }, debit: a.credit, credit: a.debit }));
  const net = balances.reduce((s, a) => s.plus(a.credit).minus(a.debit), D(0));
  lines.push({ account: 'retained_earnings', credit: net });
  const entryId = await insideLockedPeriod(ctx, to, () => postJournal(ctx, {
    date: to, refType: 'year_close', refId: close!.id, narration: `Year-end close ${fy}: profit and loss to Retained Earnings`, lines,
  }));
  if (entryId) await tx.update(fiscalCloses).set({ entryId }).where(eq(fiscalCloses.id, close!.id));

  const lock = await getSetting(tx, 'period_lock_date');
  if (!lock || lock < to) await setSetting(tx, 'period_lock_date', to, ctx.user?.id ?? null);
  await audit(ctx, 'fiscal_year', fy, 'close', null, { income: money(year.income), expense: money(year.expense), profit: money(year.profit), entryId });
  return { ...close!, entryId };
}

/** Undo a close, to correct something in that year. Only the most recently closed year can be reopened. */
export async function reopenYear(ctx: Ctx, fy: string): Promise<void> {
  const { tx } = ctx;
  await tx.execute(sql`select 1 from settings where key = 'period_lock_date' for update`);
  const [close] = await tx.select().from(fiscalCloses).where(eq(fiscalCloses.fy, fy));
  if (!close) throw conflict(`${fy} is not closed`);
  const [later] = await rows<{ fy: string }>(tx, sql`select fy from fiscal_closes where from_date > ${close.fromDate}::date order by from_date limit 1`);
  if (later) throw conflict(`${later.fy} was closed after it. Reopen that year first.`);
  await insideLockedPeriod(ctx, close.toDate, () =>
    reverseJournals(ctx, 'year_close', close.id, close.toDate, `Reopened ${fy}: closing entry reversed`));
  await tx.update(fiscalCloses).set({ entryId: null }).where(eq(fiscalCloses.id, close.id));
  await tx.delete(fiscalCloses).where(eq(fiscalCloses.id, close.id));
  await audit(ctx, 'fiscal_year', fy, 'reopen', { profit: close.profit }, null);
}

export function accountingRouter(db: DB) {
  const r = Router();

  // ---- chart of accounts ----
  r.get('/accounts', requireAuth, async (req, res) => {
    const data = await rows(db, sql`
      select a.*, p.code as parent_code,
             coalesce((select sum(l.debit) - sum(l.credit) from journal_lines l where l.account_id = a.id), 0)::numeric(16,2) as balance
        from accounts a left join accounts p on p.id = a.parent_id order by a.code`);
    // Money figures are for people with accounts access; everyone else just needs the cash/bank picker.
    const canSee = ['owner', 'accounts', 'admin'].includes(req.user!.role);
    sendList(req, res, canSee ? data : data.map((a) => ({ ...a, balance: undefined })), 'chart-of-accounts');
  });

  const zAccount = z.object({
    code: zText(20), name: zText(150), type: z.enum(ACCOUNT_TYPES), parent_id: emptyToNull(zId).optional(),
    is_group: z.boolean().default(false), subtype: emptyToNull(z.enum(['cash', 'bank'])).optional(),
  });

  r.post('/accounts', requirePerm('accounts:write'), async (req, res) => {
    const b = zAccount.parse(req.body);
    if (b.subtype && b.type !== 'asset') throw badRequest('Cash and bank accounts must be assets');
    const account = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.insert(accounts)
        .values({ code: b.code, name: b.name, type: b.type, parentId: b.parent_id ?? null, isGroup: b.is_group, subtype: b.subtype ?? null, createdBy: ctx.user!.id })
        .returning();
      await audit(ctx, 'account', row!.id, 'create', null, row);
      return row;
    });
    res.status(201).json({ data: account });
  });

  r.patch('/accounts/:id', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ name: zText(150), active: z.boolean() }).partial().parse(req.body);
    const account = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(accounts).where(eq(accounts.id, id)).for('update');
      must(before, 'Account');
      // The posting service depends on system accounts: they can be renamed, not switched off.
      if (before!.isSystem && b.active === false) throw conflict('System accounts cannot be deactivated');
      const [row] = await ctx.tx.update(accounts).set({ ...b, updatedAt: new Date() }).where(eq(accounts.id, id)).returning();
      await audit(ctx, 'account', id, 'update', before, row);
      return row;
    });
    res.json({ data: account });
  });

  // ---- expenses ----
  r.get('/expenses', requirePerm('expenses:read'), async (req, res) => {
    const q = zListQuery.extend({ category_id: zId.optional(), from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const data = await rows(db, sql`
      select e.*, c.name as category_name, a.name as paid_from, (e.amount + e.gst_amount) as total
        from expenses e join expense_categories c on c.id = e.category_id join accounts a on a.id = e.paid_from_account_id
       where (${q.category_id ?? null}::uuid is null or e.category_id = ${q.category_id ?? null}::uuid)
         and (${q.from ?? null}::date is null or e.expense_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or e.expense_date <= ${q.to ?? null}::date)
       order by e.expense_date desc, e.created_at desc limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'expenses');
  });

  r.post('/expenses', requirePerm('expenses:write'), async (req, res) => {
    const b = z.object({
      expense_date: zDate.default(() => istDate()),
      category_id: zId,
      amount: zMoneyPos,
      gst_type: z.enum(['none', 'intra', 'inter']).default('none'),
      gst_amount: emptyToNull(zMoney).optional(),
      paid_from_account_id: zId,
      vendor_name: emptyToNull(z.string().trim().max(200)).optional(),
      vendor_gstin: emptyToNull(z.string().trim().max(15)).optional(),
      attachment_url: emptyToNull(zLink).optional(),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
    }).parse(req.body);
    if (b.vendor_gstin && !isValidGstin(b.vendor_gstin)) throw badRequest('Vendor GSTIN is not valid');
    // Input credit needs the vendor's GSTIN on the bill.
    if (b.gst_type !== 'none' && !b.vendor_gstin) throw badRequest('Vendor GSTIN is required to claim input GST');
    const expense = await inTx(db, req, (ctx) =>
      createExpense(ctx, {
        expenseDate: b.expense_date, categoryId: b.category_id, amount: b.amount, gstAmount: b.gst_amount, gstType: b.gst_type,
        paidFromAccountId: b.paid_from_account_id, vendorName: b.vendor_name,
        vendorGstin: b.vendor_gstin ? normaliseGstin(b.vendor_gstin) : null, attachmentUrl: b.attachment_url, notes: b.notes,
      }));
    res.status(201).json({ data: expense });
  });

  r.post('/expenses/:id/cancel', requirePerm('expenses:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    const expense = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(expenses).where(eq(expenses.id, id)).for('update');
      must(row, 'Expense');
      if (row!.status !== 'posted') throw conflict('Expense is already cancelled');
      const [updated] = await ctx.tx.update(expenses).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(expenses.id, id)).returning();
      await reverseJournals(ctx, 'expense', id, istDate(), `Cancelled ${row!.expenseNo}: ${b.reason}`);
      await audit(ctx, 'expense', id, 'cancel', { status: 'posted' }, { status: 'cancelled', reason: b.reason });
      return updated;
    });
    res.json({ data: expense });
  });

  // ---- journals ----
  /** Day book: every entry in date order, with its lines (PRD 7.8). */
  r.get('/journals', requirePerm('accounts:read'), async (req, res) => {
    const q = zListQuery.extend({ from: zDate.optional(), to: zDate.optional(), ref_type: z.string().max(40).optional(), ref_id: zId.optional() }).parse(req.query);
    const data = await rows(db, sql`
      select e.id, e.entry_no, e.entry_date, e.ref_type, e.ref_id, e.narration, e.reverses_entry_id,
             a.code as account_code, a.name as account_name, p.name as party_name, l.debit, l.credit
        from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
        left join parties p on p.id = l.party_id
       where (${q.from ?? null}::date is null or e.entry_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or e.entry_date <= ${q.to ?? null}::date)
         and (${q.ref_type ?? null}::text is null or e.ref_type = ${q.ref_type ?? null})
         and (${q.ref_id ?? null}::uuid is null or e.ref_id = ${q.ref_id ?? null}::uuid)
       order by e.entry_date desc, e.entry_no desc, l.id
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'day-book');
  });

  /**
   * Manual journal - opening balances, corrections, year-end entries. Goes through the same
   * posting service as every document, so it must balance and cannot land in a locked period.
   */
  r.post('/journals', requirePerm('accounts:write'), async (req, res) => {
    const b = z.object({
      entry_date: zDate,
      narration: zText(500),
      lines: z.array(z.object({
        account_id: zId, party_id: emptyToNull(zId).optional(), debit: zMoney.default('0'), credit: zMoney.default('0'),
        memo: emptyToNull(z.string().trim().max(200)).optional(),
      })).min(2).max(200),
    }).parse(req.body);
    const id = await inTx(db, req, async (ctx) => {
      const used = await ctx.tx.select().from(accounts);
      const byId = new Map(used.map((a) => [a.id, a]));
      let dr = D(0), cr = D(0);
      for (const l of b.lines) {
        const account = byId.get(l.account_id);
        if (!account || !account.active) throw badRequest('Account not found');
        if (account.isGroup) throw badRequest(`${account.name} is a group; post to one of its accounts`);
        if (D(l.debit).gt(0) === D(l.credit).gt(0)) throw badRequest('Each line needs either a debit or a credit');
        // Debtors/Creditors are made of party balances: an entry without a party would break the party ledgers.
        if ((account.systemKey === 'debtors' || account.systemKey === 'creditors') && !l.party_id) {
          throw badRequest(`Pick the party for the ${account.name} line`);
        }
        // Stock in Hand must always equal the stock ledger; change it with a stock adjustment instead.
        if (account.systemKey === 'stock') throw badRequest('Stock in Hand is driven by the stock ledger. Use a stock adjustment.');
        dr = dr.plus(l.debit); cr = cr.plus(l.credit);
      }
      if (!dr.eq(cr)) throw badRequest(`Debits (${money(dr)}) and credits (${money(cr)}) must be equal`);
      const entryId = await postJournal(ctx, {
        date: b.entry_date, refType: 'manual', refId: null, narration: b.narration,
        lines: b.lines.map((l) => ({ account: { id: l.account_id }, partyId: l.party_id ?? null, debit: l.debit, credit: l.credit, memo: l.memo ?? undefined })),
      });
      await audit(ctx, 'journal_entry', entryId!, 'create_manual', null, b);
      return entryId;
    });
    res.status(201).json({ data: { id } });
  });

  r.post('/journals/:id/reverse', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500), date: zDate.default(() => istDate()) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const [entry] = await ctx.tx.select().from(journalEntries).where(eq(journalEntries.id, id));
      must(entry, 'Journal entry');
      // Document entries are reversed by cancelling the document, so the document and books stay in step.
      if (entry!.refType !== 'manual' && entry!.refType !== 'transfer') throw conflict('This entry belongs to a document. Cancel the document instead.');
      if (entry!.reversesEntryId) throw conflict('A reversal entry cannot itself be reversed');
      const [already] = await rows(ctx.tx, sql`select 1 as x from journal_entries where reverses_entry_id = ${id} limit 1`);
      if (already) throw conflict('This entry has already been reversed');
      const lines = await rows<{ account_id: string; party_id: string | null; debit: string; credit: string }>(ctx.tx, sql`
        select account_id, party_id, debit::text, credit::text from journal_lines where entry_id = ${id}`);
      await postJournal(ctx, {
        date: b.date, refType: 'manual', refId: null, narration: `Reversal of #${entry!.entryNo}: ${b.reason}`, reversesEntryId: id,
        lines: lines.map((l) => ({ account: { id: l.account_id }, partyId: l.party_id, debit: l.credit, credit: l.debit })),
      });
      await audit(ctx, 'journal_entry', id, 'reverse', null, { reason: b.reason });
    });
    res.json({ ok: true });
  });

  // ---- money moved between our own accounts ---------------------------------
  /** Cash put in the bank, cash drawn out, or one bank account to another. Undone by reversing the entry. */
  r.get('/transfers', requirePerm('accounts:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select e.id, e.entry_no, e.entry_date, e.narration,
             (select a.name from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = e.id and l.credit > 0 limit 1) as from_account,
             (select a.name from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = e.id and l.debit > 0 limit 1) as to_account,
             (select sum(l.debit) from journal_lines l where l.entry_id = e.id) as amount,
             exists (select 1 from journal_entries x where x.reverses_entry_id = e.id) as reversed
        from journal_entries e where e.ref_type = 'transfer' and e.reverses_entry_id is null
       order by e.entry_date desc, e.entry_no desc limit 200`) });
  });

  r.post('/transfers', requirePerm('accounts:write'), async (req, res) => {
    const b = z.object({
      from_account_id: zId, to_account_id: zId, amount: zMoneyPos, date: zDate.default(() => istDate()),
      reference: emptyToNull(z.string().trim().max(100)).optional(), notes: emptyToNull(z.string().trim().max(300)).optional(),
    }).parse(req.body);
    if (b.from_account_id === b.to_account_id) throw badRequest('Pick two different accounts');
    const entryId = await inTx(db, req, async (ctx) => {
      const pair = await ctx.tx.select().from(accounts).where(inArray(accounts.id, [b.from_account_id, b.to_account_id]));
      const from = pair.find((a) => a.id === b.from_account_id);
      const to = pair.find((a) => a.id === b.to_account_id);
      if (!from || !to || !from.subtype || !to.subtype || !from.active || !to.active) throw badRequest('Money can only be moved between cash and bank accounts');
      const id = await postJournal(ctx, {
        date: b.date, refType: 'transfer', refId: null,
        narration: [`${from.name} to ${to.name}`, b.reference ? `ref ${b.reference}` : null, b.notes].filter(Boolean).join(' · '),
        lines: [{ account: { id: to.id }, debit: b.amount }, { account: { id: from.id }, credit: b.amount }],
      });
      await audit(ctx, 'journal_entry', id!, 'transfer', null, { from: from.name, to: to.name, amount: b.amount, date: b.date });
      return id;
    });
    res.status(201).json({ data: { id: entryId } });
  });

  // ---- reports (all are queries over journal_lines - PRD 8.12) ----
  /**
   * Profit on each bill: what the goods on it sold for (before GST) less what they cost us, taken
   * from the cost recorded when they were delivered. A credit note takes its sale and its cost
   * back out. Services have no cost, so all of a service line is profit.
   */
  r.get('/reports/invoice-profit', requirePerm('accounts:read'), async (req, res) => {
    const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const today = istDate();
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? today;
    const data = await rows<{ sale: string; cost: string; profit: string }>(db, sql`
      select i.id, i.invoice_no, i.doc_type, i.invoice_date, coalesce(i.party_name, 'Cash Sale') as party_name, i.channel,
             (s.sign * i.taxable_total)::numeric(14,2)::text as sale,
             (s.sign * coalesce(c.cost, 0))::numeric(14,2)::text as cost,
             (s.sign * (i.taxable_total - coalesce(c.cost, 0)))::numeric(14,2)::text as profit,
             case when i.taxable_total > 0 then round(100 * (i.taxable_total - coalesce(c.cost, 0)) / i.taxable_total, 1) end as margin_pct
        from invoices i
        cross join lateral (select case when i.doc_type = 'credit_note' then -1 else 1 end as sign) s
        left join lateral (select sum(l.qty * l.unit_cost) as cost from invoice_lines l where l.invoice_id = i.id) c on true
       where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
       order by i.invoice_date desc, i.invoice_no desc limit 5000`);
    if (wantsFile(req)) return sendList(req, res, data, `profit-by-bill-${from}-to-${to}`);
    const sum = (k: 'sale' | 'cost' | 'profit') => money(data.reduce((a, r) => a.plus(r[k]), D(0)));
    res.json({ data, from, to, totals: { sale: sum('sale'), cost: sum('cost'), profit: sum('profit') } });
  });

  /** Ledger of one account with running balance. Cash book / bank book = this for a cash/bank account. */
  r.get('/reports/ledger', requirePerm('accounts:read'), async (req, res) => {
    const q = z.object({ account_id: zId, from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, q.account_id));
    must(account, 'Account');
    const [opening] = await rows<{ balance: string }>(db, sql`
      select coalesce(sum(l.debit) - sum(l.credit), 0)::numeric(16,2)::text as balance
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where l.account_id = ${q.account_id} and ${q.from ?? null}::date is not null and e.entry_date < ${q.from ?? null}::date`);
    const data = await rows<{ balance: string }>(db, sql`
      select e.entry_date, e.entry_no, e.ref_type, e.ref_id, e.narration, p.name as party_name, l.debit, l.credit,
             (${opening?.balance ?? '0'}::numeric + sum(l.debit - l.credit) over (order by e.entry_date, e.entry_no, l.id))::numeric(16,2) as balance
        from journal_lines l join journal_entries e on e.id = l.entry_id left join parties p on p.id = l.party_id
       where l.account_id = ${q.account_id}
         and (${q.from ?? null}::date is null or e.entry_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or e.entry_date <= ${q.to ?? null}::date)
       order by e.entry_date, e.entry_no, l.id`);
    if (wantsFile(req)) return sendList(req, res, data, `ledger-${account!.code}`);
    res.json({ data, account, opening_balance: opening?.balance ?? '0.00', closing_balance: data.at(-1)?.balance ?? opening?.balance ?? '0.00' });
  });

  r.get('/reports/trial-balance', requirePerm('accounts:read'), async (req, res) => {
    const q = z.object({ as_of: zDate.default(() => istDate()) }).parse(req.query);
    const totals = await accountTotals(db, null, q.as_of);
    const data = totals
      .map((a) => {
        const net = D(a.debit).minus(a.credit);
        return { code: a.code, name: a.name, type: a.type, debit: net.gt(0) ? money(net) : '0.00', credit: net.lt(0) ? money(net.neg()) : '0.00' };
      })
      .filter((a) => a.debit !== '0.00' || a.credit !== '0.00');
    if (wantsFile(req)) return sendList(req, res, data, 'trial-balance');
    const totalDebit = data.reduce((s, a) => s.plus(a.debit), D(0));
    const totalCredit = data.reduce((s, a) => s.plus(a.credit), D(0));
    res.json({ data, as_of: q.as_of, total_debit: money(totalDebit), total_credit: money(totalCredit), balanced: totalDebit.eq(totalCredit) });
  });

  r.get('/reports/profit-and-loss', requirePerm('accounts:read'), async (req, res) => {
    const today = istDate();
    const q = z.object({ from: zDate.default(() => fyRange(fyOf(today)).from), to: zDate.default(() => today) }).parse(req.query);
    const totals = await accountTotals(db, q.from, q.to, false);
    const income = totals.filter((a) => a.type === 'income').map((a) => ({ code: a.code, name: a.name, amount: money(D(a.credit).minus(a.debit)) })).filter((a) => a.amount !== '0.00');
    const expense = totals.filter((a) => a.type === 'expense').map((a) => ({ code: a.code, name: a.name, amount: money(D(a.debit).minus(a.credit)) })).filter((a) => a.amount !== '0.00');
    const totalIncome = income.reduce((s, a) => s.plus(a.amount), D(0));
    const totalExpense = expense.reduce((s, a) => s.plus(a.amount), D(0));
    if (wantsFile(req)) {
      return sendList(req, res, [...income.map((a) => ({ section: 'Income', ...a })), ...expense.map((a) => ({ section: 'Expense', ...a }))], 'profit-and-loss');
    }
    res.json({ from: q.from, to: q.to, income, expense, total_income: money(totalIncome), total_expense: money(totalExpense), net_profit: money(totalIncome.minus(totalExpense)) });
  });

  /**
   * Balance sheet as of a date. Profit to date is shown inside equity, so Assets always equal
   * Liabilities + Equity without needing a closing entry first.
   */
  r.get('/reports/balance-sheet', requirePerm('accounts:read'), async (req, res) => {
    const q = z.object({ as_of: zDate.default(() => istDate()) }).parse(req.query);
    const totals = await accountTotals(db, null, q.as_of);
    const side = (type: string, sign: 1 | -1) =>
      totals.filter((a) => a.type === type)
        .map((a) => ({ code: a.code, name: a.name, amount: money(D(a.debit).minus(a.credit).times(sign)) }))
        .filter((a) => a.amount !== '0.00');
    const assets = side('asset', 1);
    const liabilities = side('liability', -1);
    const equity = side('equity', -1);
    const profit = totals.filter((a) => a.type === 'income' || a.type === 'expense').reduce((s, a) => s.plus(a.credit).minus(a.debit), D(0));
    if (!profit.isZero()) equity.push({ code: '', name: 'Profit / (Loss) to date', amount: money(profit) });
    const sum = (list: { amount: string }[]) => list.reduce((s, a) => s.plus(a.amount), D(0));
    const totalAssets = sum(assets);
    const totalLE = sum(liabilities).plus(sum(equity));
    if (wantsFile(req)) {
      return sendList(req, res, [
        ...assets.map((a) => ({ section: 'Assets', ...a })), ...liabilities.map((a) => ({ section: 'Liabilities', ...a })),
        ...equity.map((a) => ({ section: 'Equity', ...a })),
      ], 'balance-sheet');
    }
    res.json({
      as_of: q.as_of, assets, liabilities, equity, total_assets: money(totalAssets), total_liabilities: money(sum(liabilities)),
      total_equity: money(sum(equity)), balanced: totalAssets.eq(totalLE),
    });
  });

  /** Receivables ageing by days overdue: 0-30, 31-60, 61-90, 90+ (PRD 7.10). */
  r.get('/reports/receivables-ageing', requirePerm('accounts:read'), async (req, res) => {
    const data = await rows(db, sql`
      select coalesce(o.party_id::text, 'cash') as party_id, coalesce(p.name, 'Cash Sale') as party_name, p.phone, p.credit_limit,
             sum(o.outstanding) as total,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.invoice_date) <= 0) as not_due,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.invoice_date) between 1 and 30) as d0_30,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.invoice_date) between 31 and 60) as d31_60,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.invoice_date) between 61 and 90) as d61_90,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.invoice_date) > 90) as d90_plus
        from v_invoice_outstanding o left join parties p on p.id = o.party_id
       where o.outstanding > 0 group by o.party_id, p.name, p.phone, p.credit_limit order by sum(o.outstanding) desc`);
    sendList(req, res, data, 'receivables-ageing');
  });

  r.get('/reports/payables-ageing', requirePerm('accounts:read'), async (req, res) => {
    const data = await rows(db, sql`
      select o.supplier_id as party_id, p.name as party_name, p.phone,
             sum(o.outstanding) as total,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.bill_date) <= 0) as not_due,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.bill_date) between 1 and 30) as d0_30,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.bill_date) between 31 and 60) as d31_60,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.bill_date) between 61 and 90) as d61_90,
             sum(o.outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(o.due_date, o.bill_date) > 90) as d90_plus
        from v_bill_outstanding o join parties p on p.id = o.supplier_id
       where o.outstanding > 0 group by o.supplier_id, p.name, p.phone order by sum(o.outstanding) desc`);
    sendList(req, res, data, 'payables-ageing');
  });

  /**
   * Books health check: the three things that must always be true. Used by tests and by
   * Accounts before closing a month.
   */
  r.get('/reports/integrity', requirePerm('accounts:read'), async (_req, res) => {
    const [tb] = await rows<{ d: string; c: string }>(db, sql`select coalesce(sum(debit),0)::text as d, coalesce(sum(credit),0)::text as c from journal_lines`);
    const [stockGl] = await rows<{ b: string }>(db, sql`
      select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'stock'`);
    const [stockLedger] = await rows<{ v: string }>(db, sql`select coalesce(sum(value), 0)::text as v from stock_movements`);
    const [unbalanced] = await rows<{ n: number }>(db, sql`
      select count(*)::int as n from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x`);
    const [debtorsGl] = await rows<{ b: string }>(db, sql`
      select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'debtors'`);
    const [debtorsParties] = await rows<{ b: string }>(db, sql`
      select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
       where a.system_key = 'debtors' and l.party_id is not null`);
    res.json({
      data: {
        journal_balanced: D(tb!.d).eq(tb!.c), total_debit: money(tb!.d), total_credit: money(tb!.c),
        unbalanced_entries: unbalanced!.n,
        stock_gl: money(stockGl!.b), stock_ledger_value: money(stockLedger!.v), stock_matches_gl: D(stockGl!.b).eq(stockLedger!.v),
        debtors_gl: money(debtorsGl!.b), debtors_with_party: money(debtorsParties!.b),
      },
    });
  });

  // ---- financial years ----
  /** Every financial year the books touch, newest first, with its profit and whether it can be closed. */
  r.get('/years', requirePerm('accounts:read'), async (_req, res) => {
    const today = istDate();
    const [first] = await rows<{ d: string | null }>(db, sql`select min(entry_date) as d from journal_entries`);
    const closes = await db.select().from(fiscalCloses);
    const current = fyOf(today);
    const years: Record<string, unknown>[] = [];
    let earlierOpen = false;
    for (let fy = fyOf(first?.d ?? today); ; fy = fyOf(addDays(fyRange(fy).to, 1))) {
      const { from, to } = fyRange(fy);
      const closed = closes.find((c) => c.fy === fy);
      const p = closed ? { income: D(closed.income), expense: D(closed.expense), profit: D(closed.profit) } : await profitOf(db, from, to);
      const ended = to < today;
      years.push({
        fy, from, to, status: closed ? 'closed' : ended ? 'ended' : 'current',
        income: money(p.income), expense: money(p.expense), profit: money(p.profit), closed_at: closed?.createdAt ?? null,
        can_close: !closed && ended && !earlierOpen,
        can_reopen: Boolean(closed) && !closes.some((c) => c.fromDate > from),
      });
      // A year that ended with income or expenses and was never closed holds up the ones after it.
      if (!closed && (!p.income.isZero() || !p.expense.isZero())) earlierOpen = true;
      if (fy === current) break;
    }
    res.json({ data: years.reverse() });
  });

  r.post('/years/:fy/close', requirePerm('accounts:write'), async (req, res) => {
    res.status(201).json({ data: await inTx(db, req, (ctx) => closeYear(ctx, String(req.params.fy))) });
  });

  r.post('/years/:fy/reopen', requirePerm('accounts:write'), async (req, res) => {
    await inTx(db, req, (ctx) => reopenYear(ctx, String(req.params.fy)));
    res.json({ ok: true });
  });

  r.get('/money-accounts', requireAuth, async (_req, res) => {
    res.json({ data: await db.select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype })
      .from(accounts).where(sql`${accounts.subtype} is not null and ${accounts.active}`).orderBy(asc(accounts.code)) });
  });
  return r;
}

export type { Ctx };
