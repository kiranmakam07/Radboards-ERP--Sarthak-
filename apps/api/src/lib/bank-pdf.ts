import { D } from '@radcore/shared';
import { StatementFormatError, detectColumns, parseBankDate, parseStatementTable, usable, type ParsedStatement } from './bank-csv';

/**
 * Reads a bank statement that arrives as a PDF, which is how banks email them, usually locked
 * with a password.
 *
 * A PDF has no rows or columns, only pieces of text at positions on a page. The table is put
 * back together from those positions: pieces on one baseline make a line, the line that names a
 * date column and the amount columns is the heading, and every later piece is given to the
 * column it sits under. The result goes to the same reader as a CSV statement.
 *
 * Because the layout is worked out rather than known, the reading is checked before anything is
 * kept: each balance printed on the statement must follow from the one before it. If the figures
 * do not add up as read, nothing is imported.
 */

/** The statement is locked and the password is missing or wrong. */
export class StatementPasswordError extends Error {
  constructor(public readonly reason: 'needed' | 'wrong') {
    super(reason === 'needed' ? 'This statement is locked with a password' : 'The password did not open this statement');
  }
}

export type PdfCell = { text: string; x: number; right: number };
export type PdfLine = { page: number; y: number; h: number; cells: PdfCell[] };

const MAX_PAGES = 200;
/** A figure with paise, as every amount and balance on a statement is printed: 1,23,456.78, (500.00), 500.00 Cr. */
const AMOUNT = /^\(?[-+]?[₹\d,]*\d\.\d{2}\)?(\s*(cr|dr)\.?)?$/i;

/** The text of every page as lines, top to bottom, each line's pieces left to right. */
export async function pdfLines(bytes: Uint8Array, password?: string | null): Promise<PdfLine[]> {
  const { getDocumentProxy } = await import('unpdf');
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: the reader takes the bytes it is given, and the caller may want them again.
    doc = await getDocumentProxy(new Uint8Array(bytes), password ? { password } : {});
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err.name === 'PasswordException') throw new StatementPasswordError(err.code === 1 ? 'needed' : 'wrong');
    throw new StatementFormatError('This file could not be opened as a PDF');
  }
  if (doc.numPages > MAX_PAGES) throw new StatementFormatError(`This PDF has ${doc.numPages} pages, which is more than a statement should`);

  const lines: PdfLine[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const pieces: { text: string; x: number; right: number; y: number; h: number }[] = [];
    for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      const raw = item.str ?? '';
      if (raw.trim() === '' || !item.transform) continue;
      const h = item.height || Math.abs(item.transform[3] ?? 0) || 8;
      // Spaces at either end are part of the piece's width but not of what is seen.
      const perChar = raw.length ? (item.width ?? 0) / raw.length : 0;
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      const x = item.transform[4]! + lead * perChar;
      pieces.push({ text: raw.trim().replace(/\s+/g, ' '), x, right: item.transform[4]! + (item.width ?? 0) - trail * perChar, y: item.transform[5]!, h });
    }
    // Top of the page first (PDF heights are measured from the bottom).
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    let line: PdfLine | null = null;
    for (const piece of pieces) {
      if (!line || Math.abs(piece.y - line.y) > 0.45 * Math.max(piece.h, line.h)) {
        line = { page: p, y: piece.y, h: piece.h, cells: [] };
        lines.push(line);
      }
      line.cells.push({ text: piece.text, x: piece.x, right: piece.right });
      line.h = Math.max(line.h, piece.h);
    }
  }
  for (const line of lines) {
    line.cells.sort((a, b) => a.x - b.x);
    // Words of one phrase that the file happens to store separately: closer than a space is wide.
    const merged: PdfCell[] = [];
    for (const cell of line.cells) {
      const prev = merged.at(-1);
      if (prev && cell.x - prev.right < 0.28 * line.h) {
        prev.text = `${prev.text}${cell.x - prev.right > 0.08 * line.h ? ' ' : ''}${cell.text}`;
        prev.right = Math.max(prev.right, cell.right);
      } else merged.push({ ...cell });
    }
    line.cells = merged;
  }
  return lines;
}

type Heading = { text: string; x: number; right: number };

const overlap = (a: { x: number; right: number }, b: { x: number; right: number }) => Math.min(a.right, b.right) - Math.max(a.x, b.x);

/** A heading printed on two lines ("Transaction" above "Date"): the lower words join the ones they sit under. */
function joinHeadings(upper: PdfCell[], lower: PdfCell[]): Heading[] {
  const out: Heading[] = upper.map((c) => ({ ...c }));
  for (const c of lower) {
    const over = out.filter((h) => overlap(h, c) > 0).sort((a, b) => overlap(b, c) - overlap(a, c))[0];
    if (over) {
      over.text = `${over.text} ${c.text}`;
      over.x = Math.min(over.x, c.x);
      over.right = Math.max(over.right, c.right);
    } else out.push({ ...c });
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Which heading a piece of text belongs under. */
function columnOf(cell: PdfCell, headings: Heading[]): number {
  // Figures are set against the right edge of their column, whichever way the heading is set:
  // a figure belongs to the last heading that starts to the left of where the figure ends.
  if (AMOUNT.test(cell.text)) {
    let at = 0;
    headings.forEach((h, i) => { if (h.x < cell.right - 0.5) at = i; });
    return at;
  }
  // Words start at the left of their column: the heading they overlap most, else the last one that starts before them.
  let best = -1;
  let most = 0;
  headings.forEach((h, i) => {
    const o = overlap(h, cell);
    if (o > most) { most = o; best = i; }
  });
  if (best >= 0) return best;
  let at = 0;
  headings.forEach((h, i) => { if (h.x <= cell.x + 2) at = i; });
  return at;
}

/** The statement's table, heading row first, lifted out of the lines of text. */
export function tableFromLines(lines: PdfLine[]): string[][] {
  let headings: Heading[] | null = null;
  let start = -1;
  for (let i = 0; i < lines.length && !headings; i++) {
    const one = lines[i]!.cells;
    if (usable(detectColumns(one.map((c) => c.text)))) {
      headings = one.map((c) => ({ ...c }));
      start = i + 1;
      // A second line of headings directly below ("Date" under "Transaction", "(INR)" under "Debit").
      const below = lines[i + 1];
      if (below && below.page === lines[i]!.page && lines[i]!.y - below.y < 1.7 * lines[i]!.h && !below.cells.some((c) => parseBankDate(c.text) || AMOUNT.test(c.text))) {
        const joined = joinHeadings(one, below.cells);
        if (usable(detectColumns(joined.map((h) => h.text)))) { headings = joined; start = i + 2; }
      }
    } else {
      const below = lines[i + 1];
      if (!below || below.page !== lines[i]!.page || lines[i]!.y - below.y > 1.7 * lines[i]!.h) continue;
      const joined = joinHeadings(one, below.cells);
      if (usable(detectColumns(joined.map((h) => h.text)))) { headings = joined; start = i + 2; }
    }
  }
  if (!headings) {
    const seen = lines.slice(0, 8).map((l) => l.cells.map((c) => c.text).join(' | ')).join('\n');
    throw new StatementFormatError(
      `Could not find the table in this PDF. It needs a heading with a date column and either withdrawal and deposit columns or an amount column. First lines read:\n${seen || '(no text: this may be a scanned picture)'}`,
    );
  }

  const cols = detectColumns(headings.map((h) => h.text));
  const table: string[][] = [headings.map((h) => h.text)];
  let last: { row: string[]; line: PdfLine } | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    // The heading again at the top of the next page.
    if (usable(detectColumns(line.cells.map((c) => c.text)))) {
      headings = line.cells.map((c) => ({ ...c }));
      last = null;
      continue;
    }
    const row = headings.map(() => '');
    for (const cell of line.cells) {
      const at = columnOf(cell, headings);
      row[at] = row[at] ? `${row[at]} ${cell.text}` : cell.text;
    }
    if (parseBankDate(row[cols.date!] ?? '')) {
      table.push(row);
      last = { row, line };
      continue;
    }
    // A narration that runs on to the next line: words only, close under the row it belongs to.
    const wordsOnly = !line.cells.some((c) => AMOUNT.test(c.text));
    const near = last && last.line.page === line.page && last.line.y - line.y < 2.2 * Math.max(line.h, last.line.h);
    if (last && wordsOnly && near && cols.description !== undefined && row[cols.description]) {
      last.row[cols.description] = `${last.row[cols.description]} ${row[cols.description]}`.trim();
      last.line = { ...last.line, y: line.y };
    } else last = null; // opening balance, totals, page numbers, the bank's notes
  }
  return table;
}

/**
 * The figures must add up: each printed balance is the one before plus the row's amount. A few
 * breaks are allowed for (a page total, a row the bank prints oddly); many mean the columns were
 * misread, and then nothing should be kept.
 */
export function assertBalancesAddUp(parsed: ParsedStatement): void {
  const rows = parsed.rows.filter((r) => r.balance !== null);
  if (rows.length < 3) return;
  let ok = 0;
  for (let i = 1; i < rows.length; i++) if (D(rows[i - 1]!.balance!).plus(rows[i]!.amount).eq(rows[i]!.balance!)) ok++;
  const pairs = rows.length - 1;
  if (ok / pairs < 0.8) {
    throw new StatementFormatError(
      `The amounts and balances in this PDF do not add up the way they were read (${ok} of ${pairs} rows follow from the row before), so nothing was imported. `
      + 'The layout of this statement was not understood. Download the statement as CSV or Excel from the bank and import that instead.',
    );
  }
}

/** A PDF statement, read and checked. */
export async function parsePdfStatement(bytes: Uint8Array, password?: string | null): Promise<ParsedStatement> {
  const parsed = parseStatementTable(tableFromLines(await pdfLines(bytes, password)));
  if (parsed.errors.length === 0) assertBalancesAddUp(parsed);
  return parsed;
}

/** True when the bytes are a PDF, whatever the file is called. */
export const isPdf = (bytes: Uint8Array): boolean => Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');
