import { describe, expect, it } from 'vitest';
import { StatementFormatError } from '../src/lib/bank-csv';
import { StatementPasswordError, isPdf, parsePdfStatement, pdfLines, tableFromLines } from '../src/lib/bank-pdf';
import { USUAL_COLS, statementPdf, type Col } from './statement-pdf';

// A week on the account: 1,00,000 to start with, three receipts and three payments.
const WEEK = [
  ['01-Sep-2026', '01-Sep-2026', 'UPI/CR/624512345678/RHEA MENON/HDFC/rhea@okhdfc/Payment for board', '', '', '5,900.00', '1,05,900.00'],
  ['02-Sep-2026', '02-Sep-2026', 'NEFT/N245260012345/BANGALORE BOARDS/INV-26-27-00012', '', '', '23,600.00', '1,29,500.00'],
  ['03-Sep-2026', '03-Sep-2026', 'CHQ PAID/DECK MAKERS PVT LTD', '000123', '50,000.00', '', '79,500.00'],
  ['04-Sep-2026', '04-Sep-2026', 'ACH/RENT SEP 2026/R K PROPERTIES', '', '36,000.00', '', '43,500.00'],
  ['05-Sep-2026', '05-Sep-2026', 'UPI/CR/624798765432/AMAZON SELLER SERVICES/Settlement', '', '', '12,345.67', '55,845.67'],
  ['07-Sep-2026', '07-Sep-2026', 'SMS CHARGES FOR QTR', '', '17.70', '', '55,827.97'],
];
const READ = [
  ['2026-09-01', '5900.00', '105900.00'], ['2026-09-02', '23600.00', '129500.00'], ['2026-09-03', '-50000.00', '79500.00'],
  ['2026-09-04', '-36000.00', '43500.00'], ['2026-09-05', '12345.67', '55845.67'], ['2026-09-07', '-17.70', '55827.97'],
];
const figures = (rows: { txnDate: string; amount: string; balance: string | null }[]) => rows.map((r) => [r.txnDate, r.amount, r.balance]);

describe('a statement that comes as a PDF', () => {
  it('reads the table off the page: dates, a narration over two lines, cheque number, amounts and balances', async () => {
    const pdf = await statementPdf({
      cols: USUAL_COLS, rows: WEEK,
      top: ['IDFC FIRST Bank', 'Statement of account for RADBOARDS PRIVATE LIMITED', 'Account number 10012345678  Period 01-Sep-2026 to 07-Sep-2026'],
      opening: ['', '', 'Opening Balance', '', '', '', '1,00,000.00'],
      foot: ['Total debits 86,017.70   Total credits 41,845.67', 'This is a computer generated statement and does not need a signature.'],
    });
    expect(isPdf(pdf)).toBe(true);
    const parsed = await parsePdfStatement(pdf);
    expect(parsed.errors).toEqual([]);
    expect(figures(parsed.rows)).toEqual(READ);
    // The first narration is too long for its column and runs on to a second line; both halves are kept.
    expect(parsed.rows[0]!.description).toBe('UPI/CR/624512345678/RHEA MENON/HDFC/rhea@okhdfc/Payment for board');
    expect(parsed.rows[2]).toMatchObject({ description: 'CHQ PAID/DECK MAKERS PVT LTD', reference: '000123' });
    // Nothing from above or below the table has leaked into a transaction.
    expect(parsed.rows.at(-1)!.description).toBe('SMS CHARGES FOR QTR');
    expect(parsed.columns).toMatchObject({ date: 'Transaction Date', description: 'Particulars', debit: 'Debit', credit: 'Credit', balance: 'Balance' });
  });

  it('opens a statement locked with a password, and says so plainly when the password is missing or wrong', async () => {
    const pdf = await statementPdf({ cols: USUAL_COLS, rows: WEEK, password: 'RADB0102' });
    await expect(parsePdfStatement(pdf)).rejects.toThrow(StatementPasswordError);
    await expect(parsePdfStatement(pdf)).rejects.toMatchObject({ reason: 'needed', message: 'This statement is locked with a password' });
    await expect(parsePdfStatement(pdf, 'radb0102')).rejects.toMatchObject({ reason: 'wrong', message: 'The password did not open this statement' });
    expect(figures((await parsePdfStatement(pdf, 'RADB0102')).rows)).toEqual(READ);
  });

  it('follows the table over several pages, with the heading repeated on each', async () => {
    // 40 receipts of 1,000.00, eight to a page.
    const rows = Array.from({ length: 40 }, (_, i) => {
      const day = String(1 + Math.floor(i / 2)).padStart(2, '0');
      return [`${day}/09/2026`, `${day}/09/2026`, `UPI/CR/${700000000000 + i}/CUSTOMER ${i + 1}`, '', '', '1,000.00', `${(i + 1).toLocaleString('en-IN')},000.00`];
    });
    const parsed = await parsePdfStatement(await statementPdf({ cols: USUAL_COLS, rows, rowsPerPage: 8 }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(40);
    expect(parsed.rows.map((r) => r.amount)).toEqual(Array(40).fill('1000.00'));
    expect(parsed.rows.at(-1)).toMatchObject({ txnDate: '2026-09-20', balance: '40000.00', description: 'UPI/CR/700000000039/CUSTOMER 40' });
    expect(parsed.rows[7]!.description).toBe('UPI/CR/700000000007/CUSTOMER 8'); // the page number under it is not part of it
  });

  it('copes with other layouts: headings over two lines set to the right, withdrawals and deposits, newest first', async () => {
    const cols: Col[] = [
      { title: 'Transaction', under: 'Date', x: 30, w: 60 },
      { title: 'Narration', x: 90, w: 190 },
      { title: 'Ref No.', x: 280, w: 70 },
      { title: 'Withdrawal', under: 'Amt (INR)', x: 350, w: 70, align: 'right' },
      { title: 'Deposit', under: 'Amt (INR)', x: 420, w: 70, align: 'right' },
      { title: 'Closing', under: 'Balance', x: 490, w: 75, align: 'right' },
    ];
    const rows = [...WEEK].reverse().map(([date, , text, ref, out, inn, balance]) => [date!.replace(/-Sep-/, '/09/'), text!, ref!, out!, inn!, balance!]);
    const parsed = await parsePdfStatement(await statementPdf({ cols, rows, fontSize: 8 }));
    expect(parsed.errors).toEqual([]);
    expect(figures(parsed.rows)).toEqual(READ); // put back oldest first
    expect(parsed.columns).toMatchObject({ date: 'Transaction Date', debit: 'Withdrawal Amt (INR)', credit: 'Deposit Amt (INR)', balance: 'Closing Balance' });
    expect(parsed.rows[2]!.reference).toBe('000123');
  });

  it('reads a statement with one amount column marked Dr or Cr', async () => {
    const cols: Col[] = [
      { title: 'Date', x: 30, w: 60 }, { title: 'Description', x: 90, w: 250 },
      { title: 'Amount', x: 340, w: 90, align: 'right', headAlign: 'center' }, { title: 'Balance', x: 430, w: 100, align: 'right', headAlign: 'center' },
    ];
    const rows = WEEK.map(([date, , text, , out, inn, balance]) => [date!, text!, out ? `${out} Dr` : `${inn} Cr`, `${balance} Cr`]);
    const parsed = await parsePdfStatement(await statementPdf({ cols, rows }));
    expect(figures(parsed.rows)).toEqual(READ);
  });

  it('keeps nothing when the figures do not add up as read, rather than guess', async () => {
    // The same week with the balances of another account printed beside it.
    const rows = WEEK.map((r, i) => [...r.slice(0, 6), `${(i + 1) * 7},777.00`]);
    const pdf = await statementPdf({ cols: USUAL_COLS, rows });
    await expect(parsePdfStatement(pdf)).rejects.toThrow(StatementFormatError);
    await expect(parsePdfStatement(pdf)).rejects.toThrow(/do not add up .*0 of 5 rows.* nothing was imported/s);
  });

  it('says what it saw when there is no statement table in the file', async () => {
    const letter = await statementPdf({ cols: [{ title: 'Dear customer', x: 30, w: 300 }], rows: [['Your new debit card is on its way.'], ['Regards, the bank']] });
    await expect(parsePdfStatement(letter)).rejects.toThrow(/Could not find the table in this PDF.*Dear customer/s);
    await expect(parsePdfStatement(Buffer.from('this is not a pdf at all'))).rejects.toThrow('This file could not be opened as a PDF');
    expect(isPdf(Buffer.from('Date,Narration,Debit,Credit'))).toBe(false);
  });

  it('gives each figure to the column it sits under, however the headings are set', async () => {
    // Headings set to the left, figures to the right of 60-point columns: the figure ends nearer the next heading than its own.
    const lines = await pdfLines(await statementPdf({ cols: USUAL_COLS, rows: [WEEK[2]!, WEEK[1]!] }));
    const table = tableFromLines(lines);
    expect(table[0]).toEqual(['Transaction Date', 'Value Date', 'Particulars', 'Cheque No.', 'Debit', 'Credit', 'Balance']);
    expect(table[1]).toEqual(['03-Sep-2026', '03-Sep-2026', 'CHQ PAID/DECK MAKERS PVT LTD', '000123', '50,000.00', '', '79,500.00']);
    expect(table[2]!.slice(3)).toEqual(['', '', '23,600.00', '1,29,500.00']);
  });
});
