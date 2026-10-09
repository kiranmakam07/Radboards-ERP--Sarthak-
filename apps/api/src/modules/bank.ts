import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, money } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal } from '../core/journal';
import { rows, type DB } from '../db/client';
import { accounts, bankStatementLines } from '../db/schema';
import { parseStatement, StatementFormatError } from '../lib/bank-csv';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zText, wantsFile, type Ctx } from '../lib/http';
import { createExpense } from './accounting';
import { createPayment } from './payments';

type Line = typeof bankStatementLines.$inferSelect;

/** How far apart the bank's date and our entry's date may be for an automatic match. */
const MATCH_WINDOW_DAYS = 5;

async function bankAccount(tx: DB, accountId: string) {
  const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a || a.subtype !== 'bank' || a.isGroup || !a.active) throw badRequest('Pick a bank account');
  return a;
}

type BookEntry = {
  journal_line_id: number; entry_date: string; entry_no: number; ref_type: string; ref_id: string | null; narration: string | null;
  amount: string; payment_reference: string | null; party_name: string | null;
};

/**
 * Book entries on a bank account that no statement line has been matched to yet.
 * Cancelled entries and their reversals cancel each other out and never reach the bank, so they are left out.
 */
function unmatchedBookEntries(tx: DB, accountId: string, upTo: string | null = null): Promise<BookEntry[]> {
  return rows<BookEntry>(tx, sql`
    select jl.id::int as journal_line_id, e.entry_date, e.entry_no::int as entry_no, e.ref_type, e.ref_id, e.narration,
           (jl.debit - jl.credit)::numeric(14,2)::text as amount, p.reference as payment_reference, pt.name as party_name
      from journal_lines jl
      join journal_entries e on e.id = jl.entry_id
      left join payments p on e.ref_type = 'payment' and p.id = e.ref_id
      left join parties pt on pt.id = coalesce(jl.party_id, p.party_id)
     where jl.account_id = ${accountId}
       and e.reverses_entry_id is null
       and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id)
       and not exists (select 1 from bank_statement_lines b where b.matched_journal_line_id = jl.id)
       and (${upTo}::date is null or e.entry_date <= ${upTo}::date)
     order by e.entry_date, e.entry_no`);
}

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;

async function setMatch(ctx: Ctx, lineId: string, journalLineId: number): Promise<void> {
  await ctx.tx
    .update(bankStatementLines)
    .set({ status: 'matched', matchedJournalLineId: journalLineId, matchedAt: new Date(), matchedBy: ctx.user?.id ?? null, ignoreReason: null, updatedAt: new Date() })
    .where(eq(bankStatementLines.id, lineId));
}

/**
 * Match statement lines to book entries automatically, but only when there is no doubt:
 * same amount, dates within a few days, and exactly one candidate (or exactly one whose
 * payment reference appears on the statement line). Anything ambiguous is left for a person.
 */
export async function autoMatch(ctx: Ctx, accountId: string): Promise<number> {
  const { tx } = ctx;
  const lines = await rows<{ id: string; txn_date: string; amount: string; description: string; reference: string | null }>(tx, sql`
    select id, txn_date, amount::text, description, reference from bank_statement_lines
     where account_id = ${accountId} and status = 'unmatched' order by txn_date, seq`);
  const pool = await unmatchedBookEntries(tx, accountId);
  let matched = 0;
  for (const line of lines) {
    const candidates = pool.filter((b) => D(b.amount).eq(line.amount) && daysApart(b.entry_date, line.txn_date) <= MATCH_WINDOW_DAYS);
    if (candidates.length === 0) continue;
    const haystack = `${line.reference ?? ''} ${line.description}`.toLowerCase();
    const byReference = candidates.filter((b) => b.payment_reference && b.payment_reference.length >= 4 && haystack.includes(b.payment_reference.toLowerCase()));
    const pick = byReference.length === 1 ? byReference[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!pick) continue;
    await setMatch(ctx, line.id, pick.journal_line_id);
    pool.splice(pool.indexOf(pick), 1);
    matched++;
  }
  return matched;
}

/**
 * Import a bank statement (CSV text). All or nothing: if any transaction row cannot be read,
 * nothing is saved. Rows already imported before (same or overlapping file) are skipped.
 */
export async function importStatement(ctx: Ctx, accountId: string, csv: string) {
  const { tx } = ctx;
  await bankAccount(tx, accountId);
  let parsed;
  try {
    parsed = parseStatement(csv);
  } catch (e) {
    if (e instanceof StatementFormatError) throw badRequest(e.message);
    throw e;
  }
  if (parsed.errors.length > 0) {
    throw badRequest(`${parsed.errors.length} row(s) in the file could not be read. Nothing was imported.`, { errors: parsed.errors.slice(0, 50) });
  }
  if (parsed.rows.length === 0) throw badRequest('No transactions were found in the file');

  const importId = crypto.randomUUID();
  const seen = new Map<string, number>();
  const values = parsed.rows.map((r, i) => {
    const key = `${r.txnDate}|${r.amount}|${r.description}|${r.reference ?? ''}`;
    // Two genuinely identical rows on one day (two equal UPI receipts) stay distinct by their order.
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    return {
      accountId, txnDate: r.txnDate, description: r.description, reference: r.reference, amount: r.amount, balance: r.balance,
      importId, seq: i, lineHash: crypto.createHash('sha256').update(`${key}|${nth}`).digest('hex'), createdBy: ctx.user?.id ?? null,
    };
  });
  let imported = 0;
  for (let i = 0; i < values.length; i += 500) {
    const inserted = await tx.insert(bankStatementLines).values(values.slice(i, i + 500))
      .onConflictDoNothing({ target: [bankStatementLines.accountId, bankStatementLines.lineHash] })
      .returning({ id: bankStatementLines.id });
    imported += inserted.length;
  }
  const autoMatched = await autoMatch(ctx, accountId);
  const result = {
    import_id: importId, rows_in_file: parsed.rows.length, imported, already_present: parsed.rows.length - imported,
    skipped_rows: parsed.skipped, auto_matched: autoMatched, columns_used: parsed.columns,
    from: parsed.rows[0]!.txnDate, to: parsed.rows.at(-1)!.txnDate,
  };
  await audit(ctx, 'bank_statement', importId, 'import', null, { accountId, ...result });
  return result;
}

async function lockLine(tx: DB, id: string): Promise<Line> {
  const [line] = await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, id)).for('update');
  return must(line, 'Statement line');
}

export async function matchLine(ctx: Ctx, lineId: string, journalLineId: number): Promise<void> {
  const { tx } = ctx;
  const line = await lockLine(tx, lineId);
  if (line.status === 'matched') throw conflict('This statement line is already matched');
  const entry = (await unmatchedBookEntries(tx, line.accountId)).find((b) => b.journal_line_id === journalLineId);
  if (!entry) throw conflict('That book entry is not available: it is on another account, cancelled, or already matched');
  if (!D(entry.amount).eq(line.amount)) {
    throw conflict(`Amounts differ: the statement says ${money(line.amount)}, the book entry is ${money(entry.amount)}`);
  }
  await setMatch(ctx, lineId, journalLineId);
  await audit(ctx, 'bank_statement_line', lineId, 'match', { status: line.status }, { status: 'matched', journalLineId });
}

/**
 * The bank shows a movement the books do not have yet: create the missing entry, dated as
 * on the statement, and match it in the same transaction.
 */
export async function createEntryForLine(
  ctx: Ctx,
  lineId: string,
  input:
    | { kind: 'expense'; categoryId: string; vendorName?: string | null }
    | { kind: 'party'; partyId: string }
    | { kind: 'journal'; accountId: string; narration: string },
): Promise<void> {
  const { tx } = ctx;
  const line = await lockLine(tx, lineId);
  if (line.status === 'matched') throw conflict('This statement line is already matched');
  const amount = D(line.amount);
  const abs = money(amount.abs());
  const note = [line.description, line.reference].filter(Boolean).join(' / ');
  let refType: string;
  let refId: string | null;

  if (input.kind === 'expense') {
    if (amount.gt(0)) throw badRequest('Money coming in cannot be booked as an expense');
    const expense = await createExpense(ctx, {
      expenseDate: line.txnDate, categoryId: input.categoryId, amount: abs, gstType: 'none', paidFromAccountId: line.accountId,
      vendorName: input.vendorName ?? null, notes: `From bank statement: ${note}`,
    });
    refType = 'expense';
    refId = expense.id;
  } else if (input.kind === 'party') {
    const payment = await createPayment(ctx, {
      direction: amount.gt(0) ? 'in' : 'out', partyId: input.partyId, mode: 'bank_transfer', accountId: line.accountId, amount: abs,
      reference: line.reference, paidOn: line.txnDate, notes: `From bank statement: ${note}`,
    });
    refType = 'payment';
    refId = payment.id;
  } else {
    const [contra] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
    if (!contra || !contra.active || contra.isGroup) throw badRequest('Account not found');
    if (contra.id === line.accountId) throw badRequest('Pick the other account, not the bank account itself');
    if (contra.systemKey === 'debtors' || contra.systemKey === 'creditors') throw badRequest('For a customer or supplier, choose "Receipt or payment for a party" instead');
    if (contra.systemKey === 'stock') throw badRequest('Stock in Hand is driven by the stock ledger and cannot be posted to directly');
    const entryId = await postJournal(ctx, {
      date: line.txnDate, refType: 'manual', refId: null, narration: `${input.narration} (bank statement: ${note})`,
      lines: amount.gt(0)
        ? [{ account: { id: line.accountId }, debit: abs }, { account: { id: contra.id }, credit: abs }]
        : [{ account: { id: contra.id }, debit: abs }, { account: { id: line.accountId }, credit: abs }],
    });
    const [jl] = await rows<{ id: number }>(tx, sql`
      select id::int as id from journal_lines where entry_id = ${entryId} and account_id = ${line.accountId}`);
    await setMatch(ctx, lineId, jl!.id);
    await audit(ctx, 'bank_statement_line', lineId, 'create_entry', { status: line.status }, { status: 'matched', kind: 'journal', entryId });
    return;
  }

  const [jl] = await rows<{ id: number }>(tx, sql`
    select jl.id::int as id from journal_lines jl join journal_entries e on e.id = jl.entry_id
     where e.ref_type = ${refType} and e.ref_id = ${refId} and jl.account_id = ${line.accountId} and e.reverses_entry_id is null`);
  await setMatch(ctx, lineId, jl!.id);
  await audit(ctx, 'bank_statement_line', lineId, 'create_entry', { status: line.status }, { status: 'matched', kind: input.kind, refId });
}

export function bankRouter(db: DB) {
  const r = Router();

  /** Bank accounts with their book balance and how much of the statement is still unexplained. */
  r.get('/accounts', requirePerm('accounts:read'), async (req, res) => {
    const data = await rows(db, sql`
      select a.id, a.code, a.name,
             coalesce((select sum(l.debit) - sum(l.credit) from journal_lines l where l.account_id = a.id), 0)::numeric(14,2) as book_balance,
             (select count(*)::int from bank_statement_lines b where b.account_id = a.id and b.status = 'unmatched') as unmatched_lines,
             (select max(b.txn_date) from bank_statement_lines b where b.account_id = a.id) as statement_up_to
        from accounts a where a.subtype = 'bank' and a.active and not a.is_group order by a.code`);
    sendList(req, res, data, 'bank-accounts');
  });

  r.post('/statements/import', requirePerm('accounts:write'), async (req, res) => {
    const b = z.object({ account_id: zId, csv: z.string().min(1, 'the file is empty') }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => importStatement(ctx, b.account_id, b.csv)) });
  });

  /** The reconciliation screen: statement lines, the book entries still unmatched, and the totals. */
  r.get('/reconciliation', requirePerm('accounts:read'), async (req, res) => {
    const q = z.object({
      account_id: zId, from: zDate.optional(), to: zDate.optional(), status: z.enum(['unmatched', 'matched', 'ignored']).optional(),
    }).parse(req.query);
    const account = await bankAccount(db, q.account_id);
    const lines = await rows(db, sql`
      select b.id, b.txn_date, b.description, b.reference, b.amount, b.balance, b.status, b.ignore_reason, b.matched_journal_line_id,
             e.entry_date as matched_entry_date, e.entry_no::int as matched_entry_no, e.ref_type as matched_ref_type,
             e.ref_id as matched_ref_id, e.narration as matched_narration
        from bank_statement_lines b
        left join journal_lines jl on jl.id = b.matched_journal_line_id
        left join journal_entries e on e.id = jl.entry_id
       where b.account_id = ${q.account_id}
         and (${q.from ?? null}::date is null or b.txn_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or b.txn_date <= ${q.to ?? null}::date)
         and (${q.status ?? null}::text is null or b.status::text = ${q.status ?? null})
       order by b.txn_date desc, b.seq desc limit 2000`);
    if (wantsFile(req)) return sendList(req, res, lines, 'bank-statement');
    const book = await unmatchedBookEntries(db, q.account_id, q.to ?? null);
    const [totals] = await rows<{ book_balance: string; unmatched_in: string; unmatched_out: string; unmatched_count: number }>(db, sql`
      select coalesce((select sum(l.debit) - sum(l.credit) from journal_lines l join journal_entries e on e.id = l.entry_id
                        where l.account_id = ${q.account_id} and (${q.to ?? null}::date is null or e.entry_date <= ${q.to ?? null}::date)), 0)::numeric(14,2)::text as book_balance,
             coalesce(sum(b.amount) filter (where b.status = 'unmatched' and b.amount > 0), 0)::numeric(14,2)::text as unmatched_in,
             coalesce(-sum(b.amount) filter (where b.status = 'unmatched' and b.amount < 0), 0)::numeric(14,2)::text as unmatched_out,
             count(*) filter (where b.status = 'unmatched')::int as unmatched_count
        from bank_statement_lines b
       where b.account_id = ${q.account_id} and (${q.to ?? null}::date is null or b.txn_date <= ${q.to ?? null}::date)`);
    const [closing] = await rows<{ balance: string | null; txn_date: string }>(db, sql`
      select b.balance::text, b.txn_date from bank_statement_lines b join (
               select import_id, max(created_at) as at from bank_statement_lines where account_id = ${q.account_id} group by import_id
             ) i on i.import_id = b.import_id
       where b.account_id = ${q.account_id} and b.balance is not null
         and (${q.to ?? null}::date is null or b.txn_date <= ${q.to ?? null}::date)
       order by b.txn_date desc, i.at desc, b.seq desc limit 1`);
    const bookNotOnStatement = book.reduce((s, e) => s.plus(e.amount), D(0));
    res.json({
      data: {
        account: { id: account.id, code: account.code, name: account.name },
        lines,
        unmatched_book_entries: book,
        summary: {
          book_balance: totals!.book_balance,
          statement_balance: closing?.balance ?? null,
          statement_balance_date: closing?.txn_date ?? null,
          unmatched_statement_lines: totals!.unmatched_count,
          unmatched_statement_in: totals!.unmatched_in,
          unmatched_statement_out: totals!.unmatched_out,
          unmatched_book_entries: book.length,
          unmatched_book_total: money(bookNotOnStatement),
        },
      },
    });
  });

  r.post('/lines/:id/match', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ journal_line_id: z.coerce.number().int().positive() }).parse(req.body);
    await inTx(db, req, (ctx) => matchLine(ctx, id, b.journal_line_id));
    res.json({ ok: true });
  });

  r.post('/lines/:id/unmatch', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const line = await lockLine(ctx.tx, id);
      if (line.status !== 'matched') throw conflict('This statement line is not matched');
      await ctx.tx.update(bankStatementLines)
        .set({ status: 'unmatched', matchedJournalLineId: null, matchedAt: null, matchedBy: null, updatedAt: new Date() })
        .where(eq(bankStatementLines.id, id));
      await audit(ctx, 'bank_statement_line', id, 'unmatch', { status: 'matched', journalLineId: line.matchedJournalLineId }, { status: 'unmatched' });
    });
    res.json({ ok: true });
  });

  /** For rows that should never be matched, such as a duplicate the bank printed twice. */
  r.post('/lines/:id/ignore', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(300) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const line = await lockLine(ctx.tx, id);
      if (line.status === 'matched') throw conflict('Unmatch this line before ignoring it');
      await ctx.tx.update(bankStatementLines).set({ status: 'ignored', ignoreReason: b.reason, updatedAt: new Date() }).where(eq(bankStatementLines.id, id));
      await audit(ctx, 'bank_statement_line', id, 'ignore', { status: line.status }, { status: 'ignored', reason: b.reason });
    });
    res.json({ ok: true });
  });

  r.post('/lines/:id/unignore', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const line = await lockLine(ctx.tx, id);
      if (line.status !== 'ignored') throw conflict('This statement line is not ignored');
      await ctx.tx.update(bankStatementLines).set({ status: 'unmatched', ignoreReason: null, updatedAt: new Date() }).where(eq(bankStatementLines.id, id));
      await audit(ctx, 'bank_statement_line', id, 'unignore', { status: 'ignored' }, { status: 'unmatched' });
    });
    res.json({ ok: true });
  });

  r.post('/lines/:id/create-entry', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('expense'), category_id: zId, vendor_name: emptyToNull(z.string().trim().max(200)).optional() }),
      z.object({ kind: z.literal('party'), party_id: zId }),
      z.object({ kind: z.literal('journal'), account_id: zId, narration: zText(300) }),
    ]).parse(req.body);
    await inTx(db, req, (ctx) =>
      createEntryForLine(ctx, id,
        b.kind === 'expense' ? { kind: 'expense', categoryId: b.category_id, vendorName: b.vendor_name }
        : b.kind === 'party' ? { kind: 'party', partyId: b.party_id }
        : { kind: 'journal', accountId: b.account_id, narration: b.narration }));
    res.status(201).json({ ok: true });
  });

  /** Run the automatic matching again, e.g. after entering the receipts that were missing. */
  r.post('/auto-match', requirePerm('accounts:write'), async (req, res) => {
    const b = z.object({ account_id: zId }).parse(req.body);
    const matched = await inTx(db, req, async (ctx) => {
      await bankAccount(ctx.tx, b.account_id);
      return autoMatch(ctx, b.account_id);
    });
    res.json({ data: { matched } });
  });
  return r;
}
