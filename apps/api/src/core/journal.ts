import { eq, inArray, sql } from 'drizzle-orm';
import { D, money, type Num } from '@radcore/shared';
import { rows } from '../db/client';
import type { DB } from '../db/client';
import { accounts, journalEntries, journalLines } from '../db/schema';
import { AppError, conflict } from '../lib/errors';
import type { Ctx } from '../lib/http';
import { getSetting } from './settings';

/**
 * The books. Every amount in every report comes from journal_lines, and this file is the only code
 * that writes them: a module describes an entry (postJournal) or asks for a document's entries to
 * be undone (reverseJournals); it never inserts journal rows itself.
 *
 * Accounts are named by a stable key (SystemAccount) rather than by code or id, so the chart of
 * accounts can be renumbered or renamed on screen without touching a posting rule. To post to an
 * account that has no key yet: add the key here, add the account with that key in db/seed.ts.
 */

/** Stable keys for the accounts the posting rules use. Seeded in db/seed.ts. */
export type SystemAccount =
  | 'cash' | 'bank' | 'debtors' | 'stock' | 'input_cgst' | 'input_sgst' | 'input_igst'
  | 'creditors' | 'output_cgst' | 'output_sgst' | 'output_igst' | 'output_cess' | 'grni'
  | 'capital' | 'opening_equity' | 'retained_earnings'
  | 'sales' | 'other_income' | 'cogs' | 'purchases' | 'stock_adjustment' | 'round_off'
  | 'staff_advances' | 'salaries_payable' | 'pf_payable' | 'esic_payable' | 'pt_payable' | 'tds_payable' | 'salaries'
  | 'tds_receivable' | 'tds_payable_vendors' | 'job_work_accrued' | 'forex_gain_loss'
  | 'warranty_expense' | 'landed_cost_clearing';

export type JLine = {
  /** A system key, or an explicit account id (cash/bank accounts, expense accounts, manual journals). */
  account: SystemAccount | { id: string };
  partyId?: string | null;
  debit?: Num;
  credit?: Num;
  memo?: string;
};

export type JournalInput = {
  date: string;
  refType: string;
  refId: string | null;
  narration: string;
  lines: JLine[];
  reversesEntryId?: string | null;
  /** The legal entity whose books this is in; the default entity when not given. */
  entityId?: string | null;
};

/** Refuse a date on or before the period lock (set on the Setup screen when a month is closed). */
export async function assertPeriodOpen(tx: DB, date: string): Promise<void> {
  const lock = await getSetting(tx, 'period_lock_date');
  if (lock && date <= lock) {
    throw new AppError(409, 'period_locked', `The books are locked up to ${lock}. Use a date after that.`);
  }
}

/** The account ids behind a list of system keys. A missing key is a set-up fault, so it throws rather than guesses. */
export async function systemAccountIds(tx: DB, keys: SystemAccount[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const found = await tx
    .select({ id: accounts.id, key: accounts.systemKey })
    .from(accounts)
    .where(inArray(accounts.systemKey, keys));
  const map: Record<string, string> = {};
  for (const a of found) if (a.key) map[a.key] = a.id;
  for (const k of keys) if (!map[k]) throw new Error(`System account "${k}" is missing from the chart of accounts`);
  return map;
}

/**
 * THE posting service (PRD 8.10): the only code that writes journal entries.
 * - zero lines are dropped, a negative amount flips to the other side
 * - sum(debit) must equal sum(credit) or nothing is written
 * - the entry date must be after the period lock
 * The same two rules are re-checked by database triggers at commit.
 */
export async function postJournal(ctx: Ctx, input: JournalInput): Promise<string | null> {
  const { tx } = ctx;
  const prepared: { account: JLine['account']; partyId: string | null; debit: string; credit: string; memo?: string }[] = [];
  for (const l of input.lines) {
    let debit = D(l.debit ?? 0);
    let credit = D(l.credit ?? 0);
    const net = debit.minus(credit).toDecimalPlaces(2);
    if (net.isZero()) continue;
    debit = net.gt(0) ? net : D(0);
    credit = net.lt(0) ? net.neg() : D(0);
    prepared.push({ account: l.account, partyId: l.partyId ?? null, debit: money(debit), credit: money(credit), memo: l.memo });
  }
  if (prepared.length === 0) return null;

  const totalDebit = prepared.reduce((a, l) => a.plus(l.debit), D(0));
  const totalCredit = prepared.reduce((a, l) => a.plus(l.credit), D(0));
  if (!totalDebit.eq(totalCredit)) {
    throw new AppError(500, 'unbalanced_journal',
      `Posting for ${input.refType} is not balanced (Dr ${money(totalDebit)} vs Cr ${money(totalCredit)}). Nothing was saved.`);
  }
  await assertPeriodOpen(tx, input.date);

  const keys = [...new Set(prepared.map((l) => l.account).filter((a): a is SystemAccount => typeof a === 'string'))];
  const ids = await systemAccountIds(tx, keys);

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      entryDate: input.date,
      refType: input.refType,
      refId: input.refId,
      narration: input.narration,
      reversesEntryId: input.reversesEntryId ?? null,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      createdBy: ctx.user?.id ?? null,
    })
    .returning({ id: journalEntries.id });
  if (!entry) throw new Error('journal entry insert failed');

  await tx.insert(journalLines).values(
    prepared.map((l) => ({
      entryId: entry.id,
      accountId: typeof l.account === 'string' ? (ids[l.account] as string) : l.account.id,
      partyId: l.partyId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  );
  return entry.id;
}

/**
 * Cancel a document's accounting effect. Journals are append-only, so this writes mirror
 * entries (debit <-> credit) for every live entry of the document.
 */
export async function reverseJournals(
  ctx: Ctx,
  refType: string,
  refId: string,
  date: string,
  narration: string,
): Promise<number> {
  const { tx } = ctx;
  const live = await rows<{ id: string; entity_id: string }>(tx, sql`
    select e.id, e.entity_id from journal_entries e
     where e.ref_type = ${refType} and e.ref_id = ${refId}
       and e.reverses_entry_id is null
       and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id)`);
  for (const e of live) {
    const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, e.id));
    await postJournal(ctx, {
      date,
      refType,
      refId,
      narration,
      reversesEntryId: e.id,
      entityId: e.entity_id,
      lines: lines.map((l) => ({ account: { id: l.accountId }, partyId: l.partyId, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined })),
    });
    // A cancelled entry no longer explains the bank statement line it was reconciled with. If that line was
    // matched to several entries, the whole match goes: the ones that are left no longer add up to it.
    const hit = await rows<{ id: string }>(tx, sql`
      select distinct m.statement_line_id as id from bank_line_matches m
       where m.journal_line_id in (select id from journal_lines where entry_id = ${e.id})`);
    if (hit.length > 0) {
      const lineIds = hit.map((h) => h.id);
      await tx.execute(sql`delete from bank_line_matches where statement_line_id in ${lineIds}`);
      await tx.execute(sql`
        update bank_statement_lines set status = 'unmatched', matched_at = null, matched_by = null, updated_at = now()
         where id in ${lineIds}`);
    }
  }
  return live.length;
}

/** Cash/bank account for a payment: must be a leaf account with subtype cash or bank. */
export async function assertMoneyAccount(tx: DB, accountId: string): Promise<void> {
  const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a || !a.subtype || a.isGroup || !a.active) throw conflict('Pick a cash or bank account for this payment');
}

/** Default money account for a payment mode: cash -> Cash in Hand, everything else -> Bank. */
export async function defaultMoneyAccount(tx: DB, mode: string): Promise<string> {
  const key: SystemAccount = mode === 'cash' ? 'cash' : 'bank';
  const ids = await systemAccountIds(tx, [key]);
  return ids[key] as string;
}
