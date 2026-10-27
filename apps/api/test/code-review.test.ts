import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { AppError, errorHandler, setProblemReporter } from '../src/lib/errors';
import { expectBooksHealthy, gstin, masters, openingStock, setup, type World } from './helpers';

/**
 * The module-by-module code review (27 Oct 2026, docs/CODE-REVIEW.md): each problem it found in the server, written so
 * it fails without the fix. The numbers are the tracker's.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const TODAY = istDate();
/** A day in last month, whose returns can be marked filed. */
const PAST = addDays(`${TODAY.slice(0, 7)}-01`, -3);

const balanceOf = async (key: string) => Number((await rows<{ b: string }>(w.db, sql`
  select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join accounts a on a.id = jl.account_id where a.system_key = ${key}`))[0]!.b);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  id.dealer = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Pune Boards', phone: '9700000002', gstin: gstin('27', 'DEALR1234B'), payment_terms_days: 30 }).expect(201)).body.data.id;
});
afterAll(() => w.close());

describe('CR-01 stock held at no value goes out at no value', () => {
  it('a sample board brought in at nothing is sold at a cost of nothing, and the stock value never goes below zero', async () => {
    const admin = await w.as('admin');
    id.sample = (await admin.post('/api/items').send({ sku: 'SMP-1', name: 'Sample board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, dealer_price: 1000, purchase_cost: 2500 }).expect(201)).body.data.id;
    await openingStock(w, m.stores, [{ item_id: id.sample!, qty_change: '2', unit_cost: '0' }]);
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.sample, qty: 1 }] }).expect(201)).body.data;
    await (await w.as('owner')).post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200); // below the list cost: the owner confirms
    await (await w.as('stores')).post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(201);
    const [v] = await rows<{ qty: string; value: string }>(w.db, sql`select sum(qty)::text as qty, sum(value)::text as value from stock_movements where item_id = ${id.sample}`);
    expect([Number(v!.qty), Number(v!.value)]).toEqual([1, 0]);
    await expectBooksHealthy(w);
  });
});

describe('CR-02 a server fault raised on purpose is reported', () => {
  it('sends a 500 AppError (an entry that does not balance) to the alert channel, not only unexpected ones', () => {
    const seen: string[] = [];
    setProblemReporter((err) => seen.push((err as Error).message));
    const res = { statusCode: 0, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    errorHandler(new AppError(500, 'unbalanced_journal', 'Posting for invoice is not balanced'), { method: 'POST', originalUrl: '/x' } as never, res as never, () => undefined);
    errorHandler(new AppError(409, 'conflict', 'Already done'), { method: 'POST', originalUrl: '/x' } as never, res as never, () => undefined);
    expect(seen).toEqual(['Posting for invoice is not balanced']);
    setProblemReporter(null);
  });
});

describe('CR-04 an import stays free of GST when its draft PO is edited', () => {
  it('editing the lines of a draft PO to a supplier outside India keeps GST at 0', async () => {
    const admin = await w.as('admin');
    const abroad = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Ningbo Cells', phone: '9700000066', state_code: '96' }).expect(201)).body.data.id;
    const stores = await w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: abroad, currency: 'USD', fx_rate: 84, lines: [{ item_id: id.sample, qty: 10, rate: 20 }] }).expect(201)).body.data;
    await stores.put(`/api/purchasing/orders/${po.id}/lines`).send({ lines: [{ item_id: id.sample, qty: 12, rate: 21 }] }).expect(200);
    const lines = (await admin.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines;
    expect(lines.map((l: any) => [Number(l.qty), l.rate, Number(l.gst_rate)])).toEqual([[12, '1764.00', 0]]);
  });
});

describe('CR-05 and CR-06 GST input credit: expenses and IGST paid at customs', () => {
  it('counts IGST paid at customs as input credit in GSTR-3B (4(A)(1) imports)', async () => {
    const admin = await w.as('admin');
    const abroad = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Shenzhen Motors', phone: '9700000067', state_code: '96' }).expect(201)).body.data.id;
    const ship = (await (await w.as('stores')).post('/api/imports').send({ supplier_id: abroad, currency: 'USD', fx_rate: 84 }).expect(201)).body.data;
    id.ship = ship.id;
    const accounts = await w.as('accounts');
    await accounts.post(`/api/imports/${ship.id}/costs`).send({ kind: 'igst', amount: 18000, paid_from_account_id: m.account('bank'), paid_on: TODAY }).expect(201);
    const g = (await accounts.get(`/api/gst/gstr3b?month=${TODAY.slice(0, 7)}`).expect(200)).body.data;
    expect(g.itc.imports.igst).toBe('18000.00');
    expect(g.itc.net.igst).toBe('18000.00');
    expect(await balanceOf('input_igst')).toBe(18000); // the return and the books agree
  });

  it('once a month’s GSTR-3B is filed, an expense with GST or IGST paid at customs cannot be added in it or taken out', async () => {
    const accounts = await w.as('accounts');
    const expense = (date: string, gst = 180) => accounts.post('/api/accounting/expenses').send({
      expense_date: date, category_id: m.expenseCategory('Rent'), amount: 1000, gst_type: 'intra', gst_amount: gst, paid_from_account_id: m.account('bank'), vendor_name: 'Landlord',
      vendor_gstin: gstin('27', 'LANDL1234D'),
    });
    const rent = (await expense(PAST).expect(201)).body.data;
    await accounts.post(`/api/imports/${id.ship}/costs`).send({ kind: 'igst', amount: 500, paid_from_account_id: m.account('bank'), paid_on: PAST }).expect(201);
    const igstLine = (await accounts.get(`/api/imports/${id.ship}`).expect(200)).body.data.costs.find((c: any) => c.amount === '500.00');
    await accounts.post('/api/gst/filings').send({ return_type: 'gstr3b', period: PAST.slice(0, 7), filed_on: TODAY }).expect(201);
    expect((await expense(PAST).expect(409)).body.error.message).toMatch(/GSTR-3B for .+ was filed/);
    await accounts.post(`/api/accounting/expenses/${rent.id}/cancel`).send({ reason: 'typo' }).expect(409);
    await accounts.post(`/api/imports/${id.ship}/costs`).send({ kind: 'igst', amount: 200, paid_from_account_id: m.account('bank'), paid_on: PAST }).expect(409);
    await accounts.delete(`/api/imports/${id.ship}/costs/${igstLine.id}`).expect(409);
    // An expense without GST is not in the return, so it is not held back.
    await accounts.post('/api/accounting/expenses').send({
      expense_date: PAST, category_id: m.expenseCategory('Rent'), amount: 300, gst_type: 'none', paid_from_account_id: m.account('bank'), vendor_name: 'Landlord',
    }).expect(201);
  });
});

describe('CR-07 and CR-08 balances brought in from Vyapar', () => {
  it('shows a party’s opening balance on the receivables ageing, and the import’s entries can be reversed to bring them in again', async () => {
    const accounts = await w.as('accounts');
    const csv = ['Name,Phone No.,Party Group,Receivable Balance,Payable Balance', 'Nashik Rides,9700000088,Dealer,"25,000",', 'Gear Supply,9700000089,Supplier,,"8,000"'].join('\r\n');
    await accounts.post('/api/opening/parties').send({ csv, as_of: addDays(TODAY, -1), dry_run: false }).expect(200);
    const ageing = (await accounts.get('/api/accounting/reports/receivables-ageing').expect(200)).body.data;
    expect(ageing.find((r: any) => r.party_name === 'Nashik Rides')).toMatchObject({ total: '25000.00', on_bills: '0', not_on_bills: '25000.00' });
    const payables = (await accounts.get('/api/accounting/reports/payables-ageing').expect(200)).body.data;
    expect(payables.find((r: any) => r.party_name === 'Gear Supply')).toMatchObject({ total: '8000.00', not_on_bills: '8000.00' });

    await accounts.post('/api/opening/accounts').send({ csv: 'Account,Debit,Credit\r\nCash in Hand,5000,', as_of: addDays(TODAY, -1), dry_run: false }).expect(200);
    const [entry] = await rows<{ id: string }>(w.db, sql`select id from journal_entries where ref_type = 'opening_accounts'`);
    await accounts.post(`/api/accounting/journals/${entry!.id}/reverse`).send({ reason: 'Wrong cash figure' }).expect(200);
    // CR-09: an entry is reversed once.
    await accounts.post(`/api/accounting/journals/${entry!.id}/reverse`).send({ reason: 'Again' }).expect(409);
    await accounts.post('/api/opening/accounts').send({ csv: 'Account,Debit,Credit\r\nCash in Hand,6000,', as_of: addDays(TODAY, -1), dry_run: false }).expect(200);
    await expectBooksHealthy(w);
  });
});

describe('CR-10 the staff list with phones and emails', () => {
  it('is kept to whoever manages sign-ins; the names-only list stays open', async () => {
    await (await w.as('sales')).get('/api/users').expect(403);
    const all = (await (await w.as('admin')).get('/api/users').expect(200)).body.data;
    expect(all[0]).toHaveProperty('phone');
    const lite = (await (await w.as('sales')).get('/api/masters/users-lite').expect(200)).body.data;
    expect(lite[0]).not.toHaveProperty('phone');
  });
});

describe('CR-16 zod 4: what an edit leaves out stays as it is', () => {
  it('editing an item’s reorder level keeps its prices and tax; a missing field still reads "Required"', async () => {
    const admin = await w.as('admin');
    await admin.patch(`/api/items/${id.sample}`).send({ reorder_level: 4 }).expect(200);
    const item = (await admin.get(`/api/items/${id.sample}`).expect(200)).body.data;
    expect([item.dealer_price, item.purchase_cost, Number(item.gst_rate), item.hsn_sac]).toEqual(['1000.00', '2500.00', 18, '950699']);
    const res = await admin.post('/api/items').send({ name: 'No SKU' }).expect(400);
    expect(res.body.error.message).toMatch(/: Required$/);
  });
});
