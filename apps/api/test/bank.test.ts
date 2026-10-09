import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBankAmount, parseBankDate, parseStatement, StatementFormatError } from '../src/lib/bank-csv';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, openingStock, setup, type World } from './helpers';

const TODAY = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
/** Today the way a bank prints it: DD/MM/YYYY. */
const D = `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`;

describe('reading bank statement files', () => {
  it('reads the date formats Indian banks use, day first', () => {
    expect(parseBankDate('08/10/2026')).toBe('2026-10-08');
    expect(parseBankDate('8-10-26')).toBe('2026-10-08');
    expect(parseBankDate('08-Oct-2026')).toBe('2026-10-08');
    expect(parseBankDate('08 October 2026')).toBe('2026-10-08');
    expect(parseBankDate('2026-10-08')).toBe('2026-10-08');
    expect(parseBankDate('08/10/2026 14:35:10')).toBe('2026-10-08');
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('Total')).toBeNull();
  });

  it('reads amounts with Indian grouping, brackets, signs and Dr/Cr', () => {
    expect(parseBankAmount('1,23,456.78')).toEqual({ value: '123456.78', marker: null });
    expect(parseBankAmount('(500.00)')).toEqual({ value: '-500.00', marker: null });
    expect(parseBankAmount('-59')).toEqual({ value: '-59.00', marker: null });
    expect(parseBankAmount('Rs. 2,000.50 Dr')).toEqual({ value: '2000.50', marker: 'dr' });
    expect(parseBankAmount('750 CR')).toEqual({ value: '750.00', marker: 'cr' });
    expect(parseBankAmount('')).toBeNull();
    expect(parseBankAmount('abc')).toBe('invalid');
  });

  it('finds the table under the bank\'s header lines and skips the totals row', () => {
    const p = parseStatement([
      'HDFC BANK Ltd,,,,,,', 'Account No : 000111222333,,,,,,', '',
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '01/10/26,"NEFT CR, CAPITAL",N001,01/10/26,,"1,00,000.00","1,00,000.00"',
      '02/10/26,RENT OCT,CHQ501,02/10/26,"2,000.00",,"98,000.00"',
      'Total,,,,"2,000.00","1,00,000.00",',
    ].join('\r\n'));
    expect(p.errors).toEqual([]);
    expect(p.skipped).toBe(1);
    expect(p.rows).toEqual([
      { row: 5, txnDate: '2026-10-01', description: 'NEFT CR, CAPITAL', reference: 'N001', amount: '100000.00', balance: '100000.00' },
      { row: 6, txnDate: '2026-10-02', description: 'RENT OCT', reference: 'CHQ501', amount: '-2000.00', balance: '98000.00' },
    ]);
    expect(p.columns).toMatchObject({ date: 'Date', debit: 'Withdrawal Amt.', credit: 'Deposit Amt.', balance: 'Closing Balance' });
  });

  it('puts a newest-first statement back in date order, using the running balance', () => {
    const p = parseStatement([
      'Txn Date,Description,Ref No./Cheque No.,Debit,Credit,Balance',
      '02/10/2026,B,,100.00,,900.00', '02/10/2026,A,,,500.00,1000.00', '01/10/2026,OPEN,,,500.00,500.00',
    ].join('\n'));
    expect(p.rows.map((r) => r.description)).toEqual(['OPEN', 'A', 'B']);
  });

  it('reads a single amount column with a Dr/Cr column, and refuses to guess when nothing marks withdrawals', () => {
    const p = parseStatement('Transaction Date,Particulars,Amount,Dr/Cr\n01-10-2026,ATM,500.00,DR\n01-10-2026,UPI,750.00,CR');
    expect(p.rows.map((r) => r.amount)).toEqual(['-500.00', '750.00']);
    expect(() => parseStatement('Date,Particulars,Amount\n01-10-2026,ATM,500.00\n01-10-2026,UPI,750.00')).toThrow(StatementFormatError);
    expect(() => parseStatement('Name,City\nA,B')).toThrow(/column headings/);
  });

  it('reports a transaction row it cannot read instead of dropping it', () => {
    const p = parseStatement('Date,Narration,Debit,Credit\n01/10/2026,OK,,100\n02/10/2026,BAD,abc,\n03/10/2026,BOTH,5,5');
    expect(p.rows).toHaveLength(1);
    expect(p.errors.map((e) => e.row)).toEqual([3, 4]);
  });
});

describe('bank reconciliation', () => {
  let w: World;
  let m: Awaited<ReturnType<typeof masters>>;
  const id: Record<string, string> = {};
  let bank: string;

  const statement = [
    'Account Statement,,,,,,', 'Account No: 000111222333,,,,,,',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    `${D},NEFT CR-CAPITAL INTRODUCED,N001,${D},,"1,00,000.00","1,00,000.00"`,
    `${D},UPI-RAHUL-UPI-778899,UPI-778899,${D},,"1,180.00","1,01,180.00"`,
    `${D},NEFT-BANGALORE BOARDS-NEFT12345,NEFT12345,${D},,"5,000.00","1,06,180.00"`,
    `${D},RENT OCT,CHQ501,${D},"2,000.00",,"1,04,180.00"`,
    `${D},BANK CHARGES SMS,,${D},59.00,,"1,04,121.00"`,
    `${D},INTEREST CREDIT,,${D},,210.00,"1,04,331.00"`,
    `${D},IMPS-UNKNOWN DEPOSIT,IMPS9,${D},,750.00,"1,05,081.00"`,
    'Total,,,,"2,059.00","1,07,140.00",',
  ].join('\n');

  const recon = async (query: Record<string, string> = {}) => {
    const accounts = await w.as('accounts');
    return (await accounts.get('/api/bank/reconciliation').query({ account_id: bank, ...query }).expect(200)).body.data;
  };
  const lineByText = async (text: string) => (await recon()).lines.find((l: { description: string }) => l.description.includes(text));

  beforeAll(async () => {
    w = await setup();
    m = await masters(w.db);
    bank = m.account('bank');
    const admin = await w.as('admin');
    const accounts = await w.as('accounts');
    const store = await w.as('store');
    const item = await admin.post('/api/items').send({ sku: 'BRD-1', name: 'Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 1180, purchase_cost: 500 }).expect(201);
    await openingStock(w, m.showroom, [{ item_id: item.body.data.id, qty_change: '10', unit_cost: '500' }]);
    const dealer = await accounts.post('/api/parties').send({ party_type: 'dealer', name: 'Bangalore Boards', phone: '9700000002', gstin: gstin('29', 'DEALR1234B') }).expect(201);
    id.dealer = dealer.body.data.id;
    id.item = item.body.data.id;

    // The books before the statement arrives:
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Capital introduced', lines: [{ account_id: bank, debit: 100000 }, { account_id: m.account('capital'), credit: 100000 }],
    }).expect(201);
    await store.post('/api/sales/quick-bill').send({
      customer: { phone: '9811100001', name: 'Rahul' }, lines: [{ item_id: id.item, qty: 1 }], payments: [{ mode: 'upi', amount: 1180, reference: 'UPI-778899' }],
    }).expect(201);
    const receipt = await accounts.post('/api/payments').send({ direction: 'in', party_id: id.dealer, mode: 'bank_transfer', amount: 5000, reference: 'NEFT12345' }).expect(201);
    id.receipt = receipt.body.data.id;
    await accounts.post('/api/accounting/expenses').send({ category_id: m.expenseCategory('Rent'), amount: 2000, paid_from_account_id: bank }).expect(201);
  });
  afterAll(() => w.close());

  it('only Accounts can import, and only into a bank account', async () => {
    const store = await w.as('store');
    await store.post('/api/bank/statements/import').send({ account_id: bank, csv: statement }).expect(403);
    const accounts = await w.as('accounts');
    await accounts.post('/api/bank/statements/import').send({ account_id: m.account('cash'), csv: statement }).expect(400);
  });

  it('refuses a file it cannot fully read, and saves nothing', async () => {
    const accounts = await w.as('accounts');
    const bad = await accounts.post('/api/bank/statements/import').send({ account_id: bank, csv: `Date,Narration,Debit,Credit\n${D},OK,,100\n${D},BAD,abc,` }).expect(400);
    expect(bad.body.error.message).toMatch(/1 row\(s\).*Nothing was imported/);
    expect(bad.body.error.details.errors[0].row).toBe(3);
    const unknown = await accounts.post('/api/bank/statements/import').send({ account_id: bank, csv: 'Name,City\nA,B' }).expect(400);
    expect(unknown.body.error.message).toMatch(/column headings/);
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from bank_statement_lines`);
    expect(n!.n).toBe(0);
  });

  it('imports the statement and matches what the books already explain', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.post('/api/bank/statements/import').send({ account_id: bank, csv: statement }).expect(201);
    expect(res.body.data).toMatchObject({ rows_in_file: 7, imported: 7, already_present: 0, skipped_rows: 1, auto_matched: 4, from: TODAY, to: TODAY });
    const r = await recon();
    expect(r.lines).toHaveLength(7);
    const status = Object.fromEntries(r.lines.map((l: { description: string; status: string }) => [l.description, l.status]));
    expect(status).toMatchObject({
      'NEFT CR-CAPITAL INTRODUCED': 'matched', 'UPI-RAHUL-UPI-778899': 'matched', 'NEFT-BANGALORE BOARDS-NEFT12345': 'matched', 'RENT OCT': 'matched',
      'BANK CHARGES SMS': 'unmatched', 'INTEREST CREDIT': 'unmatched', 'IMPS-UNKNOWN DEPOSIT': 'unmatched',
    });
    // Books: 1,00,000 + 1,180 + 5,000 - 2,000. Bank: its own closing balance. The gap is the three unmatched lines.
    expect(r.summary).toMatchObject({
      book_balance: '104180.00', statement_balance: '105081.00', unmatched_statement_lines: 3,
      unmatched_statement_in: '960.00', unmatched_statement_out: '59.00', unmatched_book_entries: 0,
    });
    expect(r.lines.find((l: { description: string }) => l.description === 'RENT OCT').matches[0].ref_type).toBe('expense');
  });

  it('importing the same file again adds nothing', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.post('/api/bank/statements/import').send({ account_id: bank, csv: statement }).expect(201);
    expect(res.body.data).toMatchObject({ imported: 0, already_present: 7, auto_matched: 0 });
    expect((await recon()).lines).toHaveLength(7);
  });

  it('books a bank charge, interest and an unexpected receipt straight from the statement line', async () => {
    const accounts = await w.as('accounts');
    const charge = await lineByText('BANK CHARGES');
    // Money going out cannot be income, and money coming in cannot be an expense.
    const interest = await lineByText('INTEREST');
    await accounts.post(`/api/bank/lines/${interest.id}/create-entry`).send({ kind: 'expense', category_id: m.expenseCategory('Bank Charges') }).expect(400);
    await accounts.post(`/api/bank/lines/${charge.id}/create-entry`).send({ kind: 'expense', category_id: m.expenseCategory('Bank Charges') }).expect(201);
    await accounts.post(`/api/bank/lines/${interest.id}/create-entry`).send({ kind: 'journal', account_id: m.account('other_income'), narration: 'Savings interest' }).expect(201);
    const imps = await lineByText('IMPS');
    // Debtors needs a named party, so it cannot be used as a plain contra account.
    await accounts.post(`/api/bank/lines/${imps.id}/create-entry`).send({ kind: 'journal', account_id: m.account('debtors'), narration: 'x' }).expect(400);
    await accounts.post(`/api/bank/lines/${imps.id}/create-entry`).send({ kind: 'party', party_id: id.dealer }).expect(201);

    const r = await recon();
    // Every line is explained, and the books now agree with the bank to the paisa.
    expect(r.summary).toMatchObject({ book_balance: '105081.00', statement_balance: '105081.00', unmatched_statement_lines: 0, unmatched_book_entries: 0 });
    const expenses = await accounts.get('/api/accounting/expenses').expect(200);
    expect(expenses.body.data.find((e: { category_name: string }) => e.category_name === 'Bank Charges')).toMatchObject({ amount: '59.00', expense_date: TODAY });
    const dealer = await accounts.get(`/api/parties/${id.dealer}`).expect(200);
    expect(Number(dealer.body.data.balance)).toBe(-5750); // two advances: 5,000 + 750
    await accounts.post(`/api/bank/lines/${charge.id}/create-entry`).send({ kind: 'expense', category_id: m.expenseCategory('Bank Charges') }).expect(409);
    await expectBooksHealthy(w);
  });

  it('lets a match be undone and redone by hand, but only against an entry of the same amount', async () => {
    const accounts = await w.as('accounts');
    const rent = await lineByText('RENT OCT');
    await accounts.post(`/api/bank/lines/${rent.id}/unmatch`).send({}).expect(200);
    let r = await recon();
    expect(r.summary).toMatchObject({ unmatched_statement_lines: 1, unmatched_book_entries: 1, unmatched_book_total: '-2000.00' });
    const entry = r.unmatched_book_entries[0];
    const capital = await lineByText('CAPITAL');
    await accounts.post(`/api/bank/lines/${capital.id}/match`).send({ journal_line_id: entry.journal_line_id }).expect(409); // already matched
    await accounts.post(`/api/bank/lines/${capital.id}/unmatch`).send({}).expect(200);
    const wrong = await accounts.post(`/api/bank/lines/${capital.id}/match`).send({ journal_line_id: entry.journal_line_id }).expect(409);
    expect(wrong.body.error.message).toMatch(/Amounts differ/);
    await accounts.post(`/api/bank/lines/${rent.id}/match`).send({ journal_line_id: entry.journal_line_id }).expect(200);
    // Re-running the automatic match picks the capital line back up.
    const again = await accounts.post('/api/bank/auto-match').send({ account_id: bank }).expect(200);
    expect(again.body.data.matched).toBe(1);
    r = await recon();
    expect(r.summary).toMatchObject({ unmatched_statement_lines: 0, unmatched_book_entries: 0 });
  });

  it('cancelling a reconciled receipt puts its statement line back to unmatched', async () => {
    const accounts = await w.as('accounts');
    await accounts.post(`/api/payments/${id.receipt}/cancel`).send({ reason: 'Entered against the wrong dealer' }).expect(200);
    const r = await recon();
    expect(r.lines.find((l: { description: string }) => l.description.includes('NEFT12345')).status).toBe('unmatched');
    // The cancelled receipt and its reversal are not offered as candidates.
    expect(r.summary).toMatchObject({ unmatched_statement_lines: 1, unmatched_statement_in: '5000.00', unmatched_book_entries: 0, book_balance: '100081.00' });
    const dash = await accounts.get('/api/dashboards/accounts').expect(200);
    expect(dash.body.data.bank_unreconciled).toMatchObject({ lines: 1 });
    expect(Number(dash.body.data.bank_unreconciled.amount)).toBe(5000);
  });

  it('does not guess between two equal receipts on the same day', async () => {
    const accounts = await w.as('accounts');
    for (const ref of ['', '']) {
      await accounts.post('/api/payments').send({ direction: 'in', party_id: id.dealer, mode: 'bank_transfer', amount: 300, reference: ref }).expect(201);
    }
    const res = await accounts.post('/api/bank/statements/import').send({
      account_id: bank, csv: `Date,Narration,Debit,Credit\n${D},UPI CREDIT,,300.00\n${D},UPI CREDIT,,300.00`,
    }).expect(201);
    // Two identical rows are both kept, and neither is matched automatically.
    expect(res.body.data).toMatchObject({ imported: 2, auto_matched: 0 });
    const r = await recon({ status: 'unmatched' });
    const twins = r.lines.filter((l: { description: string }) => l.description === 'UPI CREDIT');
    expect(twins).toHaveLength(2);
    const candidates = r.unmatched_book_entries.filter((e: { amount: string }) => e.amount === '300.00');
    expect(candidates).toHaveLength(2);
    await accounts.post(`/api/bank/lines/${twins[0].id}/match`).send({ journal_line_id: candidates[0].journal_line_id }).expect(200);
    // The same book entry cannot explain a second statement line.
    await accounts.post(`/api/bank/lines/${twins[1].id}/match`).send({ journal_line_id: candidates[0].journal_line_id }).expect(409);
    await accounts.post(`/api/bank/lines/${twins[1].id}/match`).send({ journal_line_id: candidates[1].journal_line_id }).expect(200);
  });

  it('a line can be set aside with a reason and brought back', async () => {
    const accounts = await w.as('accounts');
    const neft = await lineByText('NEFT12345');
    await accounts.post(`/api/bank/lines/${neft.id}/ignore`).send({}).expect(400); // reason required
    await accounts.post(`/api/bank/lines/${neft.id}/ignore`).send({ reason: 'Reversed by the bank next day' }).expect(200);
    expect((await recon()).summary.unmatched_statement_lines).toBe(0);
    await accounts.post(`/api/bank/lines/${neft.id}/unignore`).send({}).expect(200);
    expect((await recon()).summary.unmatched_statement_lines).toBe(1);
    await expectBooksHealthy(w);
  });

  it('matches one payout to the several receipts it covers, booking the fee the bank kept', async () => {
    const accounts = await w.as('accounts');
    // Three card receipts in the books: 500 + 700 + 800 = 2,000. The card company pays out 1,960 in one line, keeping 40.
    const receipts: string[] = [];
    for (const amount of [500, 700, 800]) {
      receipts.push((await accounts.post('/api/payments').send({ direction: 'in', party_id: id.dealer, mode: 'card', amount, reference: `CARD-${amount}` }).expect(201)).body.data.id);
    }
    await accounts.post('/api/bank/statements/import').send({ account_id: bank, csv: `Date,Narration,Debit,Credit\n${D},CARD SETTLEMENT TID 4412,,1960.00` }).expect(201);
    const payout = await lineByText('CARD SETTLEMENT');
    expect(payout.status).toBe('unmatched'); // no single entry of 1,960, so nothing was guessed
    const entries = (await recon()).unmatched_book_entries.filter((e: { payment_reference: string | null }) => e.payment_reference?.startsWith('CARD-'));
    expect(entries.map((e: { amount: string }) => e.amount).sort()).toEqual(['500.00', '700.00', '800.00']);
    const picked = entries.map((e: { journal_line_id: number }) => e.journal_line_id);

    // Two of the three do not add up, and the three together are 40 more than the bank paid.
    await accounts.post(`/api/bank/lines/${payout.id}/match`).send({ journal_line_ids: picked.slice(0, 2) }).expect(409);
    const short = await accounts.post(`/api/bank/lines/${payout.id}/match`).send({ journal_line_ids: picked }).expect(409);
    expect(short.body.error.message).toBe('Amounts differ: the statement says 1960.00, the 3 entries add up to 2000.00');
    expect(short.body.error.details).toMatchObject({ difference: '40.00', could_be_bank_charge: true });

    const before = (await recon()).summary.book_balance;
    await accounts.post(`/api/bank/lines/${payout.id}/match`).send({ journal_line_ids: picked, fee_category_id: m.expenseCategory('Bank Charges') }).expect(200);
    const matched = await lineByText('CARD SETTLEMENT');
    expect(matched.status).toBe('matched');
    expect(matched.matches.map((x: { amount: string; ref_type: string }) => [x.ref_type, x.amount]).sort())
      .toEqual([['expense', '-40.00'], ['payment', '500.00'], ['payment', '700.00'], ['payment', '800.00']]);
    const after = await recon();
    expect(Number(after.summary.book_balance)).toBe(Number(before) - 40); // only the fee is new in the books
    expect(after.unmatched_book_entries.filter((e: { payment_reference: string | null }) => e.payment_reference?.startsWith('CARD-'))).toEqual([]);
    const [fee] = await rows<{ amount: string; notes: string }>(w.db, sql`select amount::text, notes from expenses order by created_at desc limit 1`);
    expect(fee).toEqual({ amount: '40.00', notes: 'Kept by the bank from: CARD SETTLEMENT TID 4412' });
    // An entry already in a match cannot be used for another line.
    const neft = await lineByText('NEFT12345');
    await accounts.post(`/api/bank/lines/${neft.id}/match`).send({ journal_line_ids: [picked[0]] }).expect(409);

    // Cancelling one of the receipts undoes the whole match: what is left no longer adds up to the payout.
    await accounts.post(`/api/payments/${receipts[0]}/cancel`).send({ reason: 'Card charged twice' }).expect(200);
    const undone = await lineByText('CARD SETTLEMENT');
    expect(undone).toMatchObject({ status: 'unmatched', matches: [] });
    const left = (await recon()).unmatched_book_entries.map((e: { amount: string }) => e.amount).sort();
    expect(left).toEqual(expect.arrayContaining(['-40.00', '700.00', '800.00']));
    expect(left).not.toContain('500.00'); // the cancelled receipt is gone from the candidates
    await expectBooksHealthy(w);
  });

  it('a bank line that is more than the entries cannot be explained away as a fee', async () => {
    const accounts = await w.as('accounts');
    const payout = await lineByText('CARD SETTLEMENT'); // 1,960 in
    const small = (await recon()).unmatched_book_entries.filter((e: { amount: string }) => e.amount === '700.00' || e.amount === '800.00');
    const res = await accounts.post(`/api/bank/lines/${payout.id}/match`)
      .send({ journal_line_ids: small.map((e: { journal_line_id: number }) => e.journal_line_id), fee_category_id: m.expenseCategory('Bank Charges') }).expect(409);
    expect(res.body.error.details).toMatchObject({ difference: '-460.00', could_be_bank_charge: false });
    // 700 + 800 + the 500 less 40 that is already booked would be the right set: -40 + 700 + 800 = 1,460, still not 1,960.
    await accounts.post(`/api/bank/lines/${payout.id}/match`).send({ journal_line_ids: [] }).expect(400);
  });
});
