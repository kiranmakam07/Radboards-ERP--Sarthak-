import { D, isIsoDate, money } from '@radcore/shared';

/**
 * Reads a bank statement exported as CSV. Indian banks all lay these out differently, so
 * nothing about the layout is assumed: the header row is found by looking for a date column
 * and an amount column, and each column is recognised by its name.
 */

export type StatementRow = {
  /** 1-based row number in the file, for error messages. */
  row: number;
  txnDate: string;
  description: string;
  reference: string | null;
  /** Signed from our side: positive = money in, negative = money out. */
  amount: string;
  balance: string | null;
};

export type ParsedStatement = {
  /** Oldest first, whatever order the bank used. */
  rows: StatementRow[];
  /** Rows after the header that were not transactions (blank lines, totals, footers). */
  skipped: number;
  /** Rows that look like transactions but could not be read. Any error means nothing should be imported. */
  errors: { row: number; message: string }[];
  /** Which file column was used for what, so the user can see how the file was understood. */
  columns: Record<string, string>;
};

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Day-first dates as Indian banks print them: 08/10/2026, 08-10-26, 08-Oct-2026, 08 Oct 2026, 2026-10-08. */
export function parseBankDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s))) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    iso = `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  } else if ((m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{4}|\d{2})$/.exec(s))) {
    const month = MONTHS[m[2]!.toLowerCase()];
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    if (month) iso = `${year}-${month}-${m[1]!.padStart(2, '0')}`;
  }
  if (!iso || !isIsoDate(iso)) return null;
  // isIsoDate accepts 2026-02-31 as a string shape; make sure it is a real calendar day.
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "1,23,456.78", "₹ 500", "(500.00)", "500.00 Dr", "-500" -> a signed decimal string, or null if blank. */
export function parseBankAmount(raw: string): { value: string; marker: 'dr' | 'cr' | null } | null | 'invalid' {
  let s = raw.trim();
  if (s === '' || s === '-' || s === '--') return null;
  let marker: 'dr' | 'cr' | null = null;
  const tail = /\s*(dr|cr|debit|credit)\.?$/i.exec(s);
  if (tail) {
    marker = tail[1]!.toLowerCase().startsWith('d') ? 'dr' : 'cr';
    s = s.slice(0, tail.index);
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₹,\s]|rs\.?|inr/gi, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return 'invalid';
  const value = D(s);
  return { value: money(negative ? value.neg() : value), marker };
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

// Checked in order; the first header that matches wins for that field.
const FIELDS: Record<string, RegExp[]> = {
  date: [/^(txn|tran|transaction)(posted)?date$/, /^date$/, /^postdate$|^postingdate$/, /^valuedate$|^valuedt$/, /date/],
  description: [/^narration$/, /^(transaction)?(description|particulars|remarks|details)$/, /narration|description|particulars|remarks/],
  reference: [/chq|cheque|refno|reference|utr|instrument|tranid|transactionid/],
  // Before debit/credit, so a single "Debit/Credit" indicator column is not mistaken for an amount column.
  drcr: [/^(dr|cr)(or)?(dr|cr)$/, /^(debit|credit)(or)?(debit|credit)$/, /^(transaction|txn)?type$/],
  debit: [/^withdrawal(amt|amount)?(inr)?$/, /^debit(amt|amount)?(inr)?$/, /^dr$/, /withdrawal|debit/],
  credit: [/^deposit(amt|amount)?(inr)?$/, /^credit(amt|amount)?(inr)?$/, /^cr$/, /deposit|credit/],
  amount: [/^(txn|transaction)?amount(inr)?$/, /^amt$/],
  balance: [/balance/],
};

function detectColumns(header: string[]): Record<string, number> {
  const cols: Record<string, number> = {};
  const names = header.map(norm);
  for (const [field, patterns] of Object.entries(FIELDS)) {
    for (const pattern of patterns) {
      const idx = names.findIndex((n, i) => n !== '' && pattern.test(n) && !Object.values(cols).includes(i));
      if (idx >= 0) {
        cols[field] = idx;
        break;
      }
    }
  }
  return cols;
}

const usable = (c: Record<string, number>) =>
  c.date !== undefined && ((c.debit !== undefined && c.credit !== undefined) || c.amount !== undefined);

export class StatementFormatError extends Error {}

/**
 * Some banks list the newest transaction first. The running balance settles it (each balance
 * must equal the previous one plus the row's amount); without balances, the dates decide.
 */
function isNewestFirst(rows: StatementRow[]): boolean {
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (prev.balance === null || cur.balance === null) continue;
    if (D(prev.balance).plus(cur.amount).eq(cur.balance)) forward++;
    if (D(cur.balance).plus(prev.amount).eq(prev.balance)) backward++;
  }
  if (forward !== backward) return backward > forward;
  const first = rows[0]?.txnDate;
  const last = rows.at(-1)?.txnDate;
  return Boolean(first && last && first > last);
}

export function parseStatement(text: string): ParsedStatement {
  const table = parseCsv(text).map((r) => r.map((c) => c.trim()));
  // Banks put account details above the table: the header is the first row that names a date and an amount.
  let headerAt = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(table.length, 60); i++) {
    const candidate = detectColumns(table[i]!);
    if (usable(candidate)) {
      headerAt = i;
      cols = candidate;
      break;
    }
  }
  if (headerAt < 0) {
    const seen = table.slice(0, 5).map((r) => r.filter(Boolean).join(' | ')).filter(Boolean).join('\n');
    throw new StatementFormatError(
      `Could not find the column headings. The file needs a date column and either withdrawal and deposit columns or an amount column. First lines read:\n${seen}`,
    );
  }
  const header = table[headerAt]!;
  const cell = (r: string[], field: string) => (cols[field] === undefined ? '' : (r[cols[field]!] ?? ''));

  const rows: StatementRow[] = [];
  const errors: ParsedStatement['errors'] = [];
  let skipped = 0;
  // With one amount column, something must say which rows are withdrawals: a minus sign or a Dr/Cr marker.
  const twoColumns = cols.debit !== undefined && cols.credit !== undefined;
  let directionSeen = twoColumns;
  for (let i = headerAt + 1; i < table.length; i++) {
    const r = table[i]!;
    const rowNo = i + 1;
    if (r.every((c) => c === '')) continue;
    const txnDate = parseBankDate(cell(r, 'date'));
    if (!txnDate) {
      skipped++; // totals, "opening balance", page footers
      continue;
    }
    let amount: string | null = null;
    if (twoColumns) {
      const dr = parseBankAmount(cell(r, 'debit'));
      const cr = parseBankAmount(cell(r, 'credit'));
      if (dr === 'invalid' || cr === 'invalid') {
        errors.push({ row: rowNo, message: `Amount "${cell(r, dr === 'invalid' ? 'debit' : 'credit')}" is not a number` });
        continue;
      }
      const out = dr ? D(dr.value).abs() : D(0);
      const inn = cr ? D(cr.value).abs() : D(0);
      if (out.gt(0) && inn.gt(0)) {
        errors.push({ row: rowNo, message: 'Row has both a withdrawal and a deposit' });
        continue;
      }
      amount = money(inn.minus(out));
    } else {
      const a = parseBankAmount(cell(r, 'amount'));
      if (a === 'invalid') {
        errors.push({ row: rowNo, message: `Amount "${cell(r, 'amount')}" is not a number` });
        continue;
      }
      if (a) {
        const flag = norm(cell(r, 'drcr'));
        const marker = a.marker ?? (flag.startsWith('d') || flag.startsWith('w') ? 'dr' : flag.startsWith('c') ? 'cr' : null);
        const abs = D(a.value).abs();
        if (marker || D(a.value).lt(0)) directionSeen = true;
        amount = money(marker === 'dr' ? abs.neg() : marker === 'cr' ? abs : a.value);
      }
    }
    if (amount === null || D(amount).isZero()) {
      errors.push({ row: rowNo, message: 'Row has a date but no amount' });
      continue;
    }
    const bal = parseBankAmount(cell(r, 'balance'));
    let balance: string | null = null;
    if (bal && bal !== 'invalid') balance = money(bal.marker === 'dr' ? D(bal.value).abs().neg() : bal.value);
    rows.push({
      row: rowNo,
      txnDate,
      description: cell(r, 'description').replace(/\s+/g, ' ').slice(0, 500),
      reference: cell(r, 'reference').replace(/\s+/g, ' ').slice(0, 100) || null,
      amount,
      balance,
    });
  }
  if (isNewestFirst(rows)) rows.reverse();
  if (!directionSeen && rows.length > 0) {
    throw new StatementFormatError(
      'The file has one amount column and nothing that marks withdrawals (no minus signs and no Dr/Cr column), so deposits and withdrawals cannot be told apart.',
    );
  }
  return { rows, skipped, errors, columns: Object.fromEntries(Object.entries(cols).map(([f, i]) => [f, header[i] ?? ''])) };
}
