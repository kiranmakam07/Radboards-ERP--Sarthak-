import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, onHand, setup, type World } from './helpers';

/**
 * Moving from Vyapar (modules/opening.ts): Vyapar's closing balances come in as RadCore's opening balances, from
 * the files Vyapar exports, and the two can be compared afterwards. Figures worked out by hand:
 *   parties   Pune Boards (dealer) owes 45,000; Ningbo Cells (supplier) is owed 30,000; Rhea (customer) paid 2,000 ahead
 *   stock     20 boards at 2,500 = 50,000; 2 scooters at 60,000 = 1,20,000
 *   accounts  cash 25,000, bank 3,10,000, a loan of 1,00,000
 * Opening Balance Equity = what the business is worth on these figures:
 *   45,000 - 30,000 - 2,000 + 50,000 + 1,20,000 + 25,000 + 3,10,000 - 1,00,000 = 4,18,000 (a credit).
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const AS_OF = addDays(istDate(), -1);

const balanceOf = async (code: string) => Number((await rows<{ b: string }>(w.db, sql`
  select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join accounts a on a.id = jl.account_id where a.code = ${code}`))[0]!.b);
const partyBalance = async (name: string) => Number((await rows<{ b: string }>(w.db, sql`
  select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join parties p on p.id = jl.party_id where p.name = ${name}`))[0]!.b);

// As Vyapar's party list is saved to CSV: its own column names, Indian number formatting, a receivable and a payable column.
const PARTIES_BAD = [
  'Name,Phone No.,Email,GSTIN,Party Group,State,Receivable Balance,Payable Balance',
  `Pune Boards,9822000001,,${gstin('27', 'PUNEB1234C')},Dealer,Maharashtra,"45,000.00",`,
  'Ningbo Cells,98220,,27XXXXX,Supplier,Outside India,,"30,000.00"',
  'Rhea Menon,9822000003,rhea@,,Customer,Karnataka,,"2,000.00"',
].join('\r\n');
const PARTIES = [
  'Name,Phone No.,Email,GSTIN,Party Group,State,Receivable Balance,Payable Balance',
  `Pune Boards,9822000001,,${gstin('27', 'PUNEB1234C')},Dealer,Maharashtra,"45,000.00",`,
  'Ningbo Cells,,,,Supplier,Outside India,,"30,000.00"',
  'Rhea Menon,9822000003,rhea@example.com,,Customer,Karnataka,,"2,000.00"',
].join('\r\n');
const ITEMS = [
  'Item Name,Item Code,HSN,Tax Rate,Sale Price,Purchase Price,Stock Quantity,Stock Value,Type,Serials',
  'Cruiser Board,BRD-1,950699,GST@18%,5900,2500,20,"50,000.00",,',
  'Electric Scooter S1,EV-S1,871160,5,95000,60000,2,"1,20,000.00",Vehicle,S1-VY-001;S1-VY-002',
  'Fitting labour,LAB-1,,18,500,,,,Service,',
].join('\r\n');
const ACCOUNTS = ['Account,Debit,Credit', 'Cash in Hand,25000,', 'Bank Account,"3,10,000",', 'Term Loan from HDFC,,"1,00,000"'].join('\r\n');

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
});
afterAll(() => w.close());

describe('moving from Vyapar: parties and their balances', () => {
  it('checks the file first: every problem on its row, and nothing is saved', async () => {
    const accounts = await w.as('accounts');
    const res = (await accounts.post('/api/opening/parties').send({ csv: PARTIES_BAD, as_of: AS_OF }).expect(200)).body.data;
    expect(res.problems).toBe(3);
    expect(res.rows.find((r: any) => r.name === 'Ningbo Cells').problems).toEqual(['Phone "98220" is not a phone number', 'GSTIN "27XXXXX" is not a valid GSTIN']);
    expect(res.rows.find((r: any) => r.name === 'Rhea Menon').problems).toEqual(['Email "rhea@" is not an email address']);
    expect(res.rows.find((r: any) => r.name === 'Pune Boards')).toMatchObject({ party_type: 'dealer', state_code: '27', balance: '45000.00', problems: [] });
    // Brought in as it is: refused whole.
    const refused = await accounts.post('/api/opening/parties').send({ csv: PARTIES_BAD, as_of: AS_OF, dry_run: false }).expect(400);
    expect(refused.body.error.message).toMatch(/Nothing was brought in: 3 problem/);
    expect(Number((await rows<{ n: string }>(w.db, sql`select count(*)::text as n from parties`))[0]!.n)).toBe(0);
    await (await w.as('sales')).post('/api/opening/parties').send({ csv: PARTIES, as_of: AS_OF }).expect(403);
  });

  it('brings the parties in with their closing balances, against Opening Balance Equity', async () => {
    const accounts = await w.as('accounts');
    const res = (await accounts.post('/api/opening/parties').send({ csv: PARTIES, as_of: AS_OF, dry_run: false }).expect(200)).body.data;
    expect(res.imported).toEqual({ parties: 3, receivable: '45000.00', payable: '32000.00' });
    expect(await partyBalance('Pune Boards')).toBe(45000);
    expect(await partyBalance('Ningbo Cells')).toBe(-30000);
    expect(await partyBalance('Rhea Menon')).toBe(-2000);
    expect(await balanceOf('1200')).toBe(43000); // Debtors: Pune's 45,000 less Rhea's 2,000 paid ahead
    expect(await balanceOf('2100')).toBe(-30000); // Creditors
    expect(await balanceOf('3200')).toBe(-13000);
    const ningbo = (await rows<{ state_code: string }>(w.db, sql`select state_code from parties where name = 'Ningbo Cells'`))[0]!;
    expect(ningbo.state_code).toBe('96');
    // The same file again finds them all already here.
    const again = (await accounts.post('/api/opening/parties').send({ csv: PARTIES, as_of: AS_OF }).expect(200)).body.data;
    expect(again.rows.every((r: any) => r.problems.some((p: string) => /Already in RadCore/.test(p)))).toBe(true);
  });
});

describe('moving from Vyapar: items and their stock', () => {
  it('needs serial numbers for vehicles, an HSN for goods, and brings the stock in at its value', async () => {
    const accounts = await w.as('accounts');
    const noSerials = ITEMS.replace('S1-VY-001;S1-VY-002', '');
    const checked = (await accounts.post('/api/opening/items').send({ csv: noSerials, as_of: AS_OF }).expect(200)).body.data;
    expect(checked.rows.find((r: any) => r.sku === 'EV-S1').problems).toEqual(['A vehicle is kept by serial: give its 2 serial number(s), separated by ;']);
    expect(checked.rows.find((r: any) => r.sku === 'BRD-1')).toMatchObject({ gst_rate: '18', qty: '20.000', unit_cost: '2500.00', problems: [] });

    const res = (await accounts.post('/api/opening/items').send({ csv: ITEMS, as_of: AS_OF, dry_run: false, location_id: m.stores }).expect(200)).body.data;
    expect(res.imported).toEqual({ items: 3, with_stock: 2, stock_value: '170000.00' });
    const board = (await rows<{ id: string }>(w.db, sql`select id from items where sku = 'BRD-1'`))[0]!.id;
    expect(await onHand(w.db, board, m.stores)).toBe(20);
    const units = await rows<{ serial_no: string; status: string }>(w.db, sql`select serial_no, status from units order by serial_no`);
    expect(units).toEqual([{ serial_no: 'S1-VY-001', status: 'available' }, { serial_no: 'S1-VY-002', status: 'available' }]);
    expect(await balanceOf('1300')).toBe(170000); // Stock in Hand
    expect(await balanceOf('3200')).toBe(-183000);
  });
});

describe('moving from Vyapar: the other account balances', () => {
  it('brings cash, bank and a loan in as one entry, once; an account not in the chart is named', async () => {
    const accounts = await w.as('accounts');
    const missing = (await accounts.post('/api/opening/accounts').send({ csv: ACCOUNTS, as_of: AS_OF }).expect(200)).body.data;
    expect(missing.rows[2].problems[0]).toMatch(/No account Term Loan from HDFC in the chart of accounts: add it there first/);
    const sales = (await accounts.post('/api/opening/accounts').send({ csv: 'Account,Debit,Credit\r\nSales,,500\r\nDebtors (Accounts Receivable),100,', as_of: AS_OF }).expect(200)).body.data;
    expect(sales.rows[0].problems[0]).toMatch(/Sales is income: bring the year's profit so far as one figure under Retained Earnings/);
    expect(sales.rows[1].problems[0]).toMatch(/come in with the parties/);

    await (await w.as('admin')).post('/api/accounting/accounts').send({ code: '2600', name: 'Term Loan from HDFC', type: 'liability' }).expect(201);
    const res = (await accounts.post('/api/opening/accounts').send({ csv: ACCOUNTS, as_of: AS_OF, dry_run: false }).expect(200)).body.data;
    expect(res.imported).toEqual({ accounts: 3, to_opening_equity: '235000.00' });
    expect(await balanceOf('1100')).toBe(25000);
    expect(await balanceOf('1110')).toBe(310000);
    expect(await balanceOf('2600')).toBe(-100000);
    // What the business is worth on Vyapar's figures (see the top of this file).
    expect(await balanceOf('3200')).toBe(-418000);
    await accounts.post('/api/opening/accounts').send({ csv: ACCOUNTS, as_of: AS_OF, dry_run: false }).expect(409);
    await expectBooksHealthy(w);
  });
});

describe('comparing with Vyapar during the month side by side', () => {
  it('lists each party, item and account with both figures and the difference', async () => {
    const accounts = await w.as('accounts');
    // Vyapar a week on: Pune paid 5,000 there but not here yet; Rhea's advance is the same.
    const vyParties = ['Name,GSTIN,Receivable Balance,Payable Balance', `Pune Boards,${gstin('27', 'PUNEB1234C')},"40,000.00",`, 'Rhea Menon,,,2000'].join('\r\n');
    const parties = (await accounts.post('/api/opening/compare/parties').send({ csv: vyParties, as_of: istDate() }).expect(200)).body.data;
    expect(parties.rows).toEqual([
      { row: 2, name: 'Pune Boards', vyapar: '40000.00', radcore: '45000.00', difference: '5000.00', found: true },
      { row: 3, name: 'Rhea Menon', vyapar: '-2000.00', radcore: '-2000.00', difference: '0.00', found: true },
      // In RadCore with a balance, and not in Vyapar's list at all.
      { row: null, name: 'Ningbo Cells', vyapar: null, radcore: '-30000.00', difference: '-30000.00', found: true },
    ]);
    expect(parties.totals.differences).toBe(2);

    const vyStock = ['Item Name,Item Code,Stock Quantity,Stock Value', 'Cruiser Board,BRD-1,19,"47,500.00"', 'Electric Scooter S1,EV-S1,2,"1,20,000"'].join('\r\n');
    const stock = (await accounts.post('/api/opening/compare/items').send({ csv: vyStock, as_of: istDate() }).expect(200)).body.data;
    expect(stock.rows[0]).toMatchObject({ name: 'Cruiser Board (quantity: Vyapar 19, RadCore 20)', vyapar: '47500.00', radcore: '50000.00', difference: '2500.00' });
    expect(stock.rows[1]).toMatchObject({ difference: '0.00' });

    const accts = (await accounts.post('/api/opening/compare/accounts').send({ csv: 'Account,Debit,Credit\r\nCash in Hand,25000,\r\nNo such book,1,', as_of: istDate() }).expect(200)).body.data;
    expect(accts.rows).toEqual([
      { row: 2, name: '1100 Cash in Hand', vyapar: '25000.00', radcore: '25000.00', difference: '0.00', found: true },
      { row: 3, name: 'No such book', vyapar: '1.00', radcore: '0.00', difference: '-1.00', found: false },
    ]);
    // The owner can compare too; a salesperson cannot.
    await (await w.as('owner')).post('/api/opening/compare/parties').send({ csv: vyParties, as_of: istDate() }).expect(200);
    await (await w.as('sales')).post('/api/opening/compare/parties').send({ csv: vyParties, as_of: istDate() }).expect(403);
  });

  it('gives a template for each step', async () => {
    const t = await (await w.as('accounts')).get('/api/opening/template/parties').expect(200);
    expect(t.headers['content-type']).toContain('text/csv');
    expect(t.text.split('\r\n')[0]).toBe('name,type,phone,email,gstin,state,address,city,pincode,credit_limit,payment_terms_days,receivable,payable');
  });
});
