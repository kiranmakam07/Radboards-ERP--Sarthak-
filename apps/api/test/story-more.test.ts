import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, fyOf, fyRange, istDate, weekdayOf } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, onHand, openingStock, setup, type World } from './helpers';

/**
 * More stories, each on an empty company of its own, for the flows the first story (story.test.ts)
 * does not walk through. As there, every step is checked in every section it should reach, against
 * figures worked out by hand:
 *
 *   A. a dealer in another state: IGST, a credit limit, tax held back by the customer
 *   B. returns, credits and cancellations: everything undone everywhere it was done
 *   C. a stock count, closing the year, and the period lock
 *   D. job work feeding into the cost of a sale, and an Amazon order
 *   E. a month's salary with PF, ESIC, professional tax, leave and an advance
 *   F. leads: repeats, turns, plans, lost and back, imports, and what marketing sees
 */
const TODAY = istDate();
const YESTERDAY = addDays(TODAY, -1);

type Ctx = { w: World; m: Awaited<ReturnType<typeof masters>> };

/** Every account's balance, debit positive, as the trial balance shows it. */
async function books(w: World): Promise<Record<string, number>> {
  const tb = (await (await w.as('accounts')).get('/api/accounting/reports/trial-balance').expect(200)).body;
  expect(tb.balanced).toBe(true);
  return Object.fromEntries(tb.data.map((a: any) => [a.name, Number(a.debit) - Number(a.credit)]));
}
const acct = (b: Record<string, number>, name: string) => b[name] ?? 0;

async function stockValue(w: World, itemId: string): Promise<number> {
  const v = (await (await w.as('accounts')).get('/api/stock/valuation').expect(200)).body.data.find((r: any) => r.item_id === itemId);
  return Number(v?.value ?? 0);
}

/** What customers owe us, as "To collect" lists it. */
async function toCollect(w: World): Promise<Record<string, number>> {
  const owe = (await (await w.as('accounts')).get('/api/payments/reminders').expect(200)).body.data;
  return Object.fromEntries(owe.map((r: any) => [r.party_name, Number(r.total)]));
}

async function gst(w: World) {
  const g = (await (await w.as('accounts')).get('/api/gst/gstr3b').query({ from: fyRange(fyOf(TODAY)).from, to: TODAY }).expect(200)).body.data;
  return { igst: Number(g.outward.net.igst), cgst: Number(g.outward.net.cgst), sgst: Number(g.outward.net.sgst), claimable: Number(g.itc.total_tax) };
}

async function profit(w: World, from = fyRange(fyOf(TODAY)).from, to = TODAY) {
  const pl = (await (await w.as('accounts')).get('/api/accounting/reports/profit-and-loss').query({ from, to }).expect(200)).body;
  return { income: Number(pl.total_income), expense: Number(pl.total_expense), net: Number(pl.net_profit) };
}

async function start(): Promise<Ctx> {
  const w = await setup();
  return { w, m: await masters(w.db) };
}

async function board(c: Ctx, sku = 'BRD-1') {
  return (await (await c.w.as('admin')).post('/api/items').send({
    sku, name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 4130, dealer_price: 3500, purchase_cost: 2000,
  }).expect(201)).body.data.id as string;
}

async function party(c: Ctx, body: Record<string, unknown>) {
  return (await (await c.w.as('admin')).post('/api/parties').send(body).expect(201)).body.data.id as string;
}

async function capital(c: Ctx, amount: number, date = TODAY) {
  await (await c.w.as('accounts')).post('/api/accounting/journals').send({
    entry_date: date, narration: "Owner's money in", lines: [{ account_id: c.m.account('bank'), debit: amount }, { account_id: c.m.account('capital'), credit: amount }],
  }).expect(201);
}

/** Quote -> confirmed -> delivered -> invoiced, the way the screens do it. Returns the invoice. */
async function sell(c: Ctx, partyId: string, itemId: string, qty: number, channel: 'dealer' | 'store') {
  const sales = await c.w.as('sales');
  const order = (await sales.post('/api/sales/orders').send({ channel, party_id: partyId, lines: [{ item_id: itemId, qty }] }).expect(201)).body.data;
  await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
  await sales.post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(201);
  return (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({}).expect(201)).body.data;
}

// =====================================================================================================
describe('A. A dealer in another state', () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  beforeAll(async () => { c = await start(); });
  afterAll(() => c.w.close());

  it('opening stock: 20 boards at 2,000 are in Stores and in the books as 40,000', async () => {
    id.board = await board(c);
    await openingStock(c.w, c.m.stores, [{ item_id: id.board, qty_change: '20', unit_cost: '2000' }]);
    const b = await books(c.w);
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(20);
    expect(await stockValue(c.w, id.board)).toBe(40000);
    expect(acct(b, 'Stock in Hand')).toBe(40000);
    expect(acct(b, 'Opening Balance Equity')).toBe(-40000);
  });

  it('10 boards to a Karnataka dealer: the invoice carries IGST, not CGST and SGST, and GSTR-1 lists it as B2B', async () => {
    id.dealer = await party(c, { party_type: 'dealer', name: 'Southside Skates', phone: '9845000001', gstin: gstin('29', 'DEALR1234B'), credit_limit: 50000, payment_terms_days: 30 });
    const inv = await sell(c, id.dealer, id.board, 10, 'dealer');
    id.inv = inv.id;
    expect(inv).toMatchObject({ taxable_total: '35000.00', igst_total: '6300.00', cgst_total: '0.00', sgst_total: '0.00', grand_total: '41300.00' });
    expect(await gst(c.w)).toMatchObject({ igst: 6300, cgst: 0, sgst: 0 });
    const b2b = (await (await c.w.as('accounts')).get('/api/gst/gstr1').query({ from: fyRange(fyOf(TODAY)).from, to: TODAY, section: 'b2b' }).expect(200)).body.data;
    expect(JSON.stringify(b2b)).toContain(inv.invoice_no);
    expect(JSON.stringify(b2b)).toContain(gstin('29', 'DEALR1234B'));
    expect(await toCollect(c.w)).toEqual({ 'Southside Skates': 41300 });
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(10);
    expect(acct(await books(c.w), 'Cost of Goods Sold')).toBe(20000);
  });

  it('a second order would take him past his 50,000 limit: Sales is stopped, Accounts can let it through, and cancelling it posts nothing', async () => {
    const sales = await c.w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 5 }] }).expect(201)).body.data;
    const stopped = await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(409);
    expect(stopped.body.error.message).toMatch(/credit limit/); // 41,300 owed + 20,650 = 61,950
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({ override_credit: true }).expect(403);
    await (await c.w.as('accounts')).post(`/api/sales/orders/${order.id}/confirm`).send({ override_credit: true }).expect(200);
    const before = await books(c.w);
    const cancelled = (await sales.post(`/api/sales/orders/${order.id}/cancel`).send({ reason: 'Dealer changed his mind' }).expect(200)).body.data;
    expect(cancelled.status).toBe('cancelled');
    expect(await books(c.w)).toEqual(before);
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(10);
  });

  it('he pays 40,600 and holds back 700 as TDS: the invoice is settled, the bank gets 40,600, and the 700 waits to be claimed', async () => {
    const paid = (await (await c.w.as('accounts')).post('/api/payments').send({
      direction: 'in', party_id: id.dealer, mode: 'bank_transfer', amount: 40600, tds_amount: 700, reference: 'NEFT-SS-1',
      allocations: [{ invoice_id: id.inv, amount: 41300 }],
    }).expect(201)).body.data;
    expect(paid).toMatchObject({ amount: '40600.00', tds_amount: '700.00' });
    const b = await books(c.w);
    expect(acct(b, 'Bank Account')).toBe(40600);
    expect(acct(b, 'TDS Receivable')).toBe(700);
    expect(acct(b, 'Debtors (Accounts Receivable)')).toBe(0);
    expect(await toCollect(c.w)).toEqual({});
    const tds = (await (await c.w.as('accounts')).get('/api/tds/receivable').expect(200)).body;
    expect(JSON.stringify(tds)).toContain('Southside Skates');
    expect(JSON.stringify(tds)).toContain('700.00');
  });

  it('the reports agree: profit by customer, the sales dashboard and the balance sheet', async () => {
    const pp = (await (await c.w.as('accounts')).get('/api/accounting/reports/party-profit').expect(200)).body;
    expect(pp.data.find((r: any) => r.party_name === 'Southside Skates')).toMatchObject({ sale: '35000.00', cost: '20000.00', profit: '15000.00' });
    const dash = (await (await c.w.as('owner')).get('/api/dashboards/sales').expect(200)).body.data;
    expect(dash.sales_in_range.reduce((s: number, r: any) => s + Number(r.taxable), 0)).toBe(35000);
    expect(await profit(c.w)).toEqual({ income: 35000, expense: 20000, net: 15000 });
    await expectBooksHealthy(c.w);
  });
});

// =====================================================================================================
describe('B. Returns, credits and cancellations', () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  beforeAll(async () => {
    c = await start();
    id.board = await board(c);
    await openingStock(c.w, c.m.stores, [{ item_id: id.board, qty_change: '10', unit_cost: '2000' }]);
    id.rao = await party(c, { party_type: 'customer', name: 'Rao Sports', phone: '9822000001' });
    // A customer's order is served from the showroom, so some boards go there first.
    await (await c.w.as('stores')).post('/api/stock/transfers').send({ from_location_id: c.m.stores, to_location_id: c.m.showroom, reason: 'Display', lines: [{ item_id: id.board, qty: 5 }] }).expect(201);
  });
  afterAll(() => c.w.close());

  it('2 boards sold at the counter price and paid for in full', async () => {
    const inv = await sell(c, id.rao, id.board, 2, 'store');
    id.inv1 = inv.id;
    expect(inv).toMatchObject({ taxable_total: '7000.00', cgst_total: '630.00', sgst_total: '630.00', grand_total: '8260.00' });
    await (await c.w.as('accounts')).post('/api/payments').send({ direction: 'in', party_id: id.rao, mode: 'upi', amount: 8260, allocations: [{ invoice_id: id.inv1, amount: 8260 }] }).expect(201);
    expect(await onHand(c.w.db, id.board, c.m.showroom)).toBe(3);
    expect(await toCollect(c.w)).toEqual({});
    expect(acct(await books(c.w), 'Bank Account')).toBe(8260);
  });

  it('one comes back: the credit note puts it on the shelf and leaves her 4,130 in credit, owed nothing', async () => {
    const accounts = await c.w.as('accounts');
    const line = (await accounts.get(`/api/sales/invoices/${id.inv1}`).expect(200)).body.data.lines[0].id;
    const cn = (await accounts.post(`/api/sales/invoices/${id.inv1}/credit-note`).send({ lines: [{ invoice_line_id: line, qty: 1 }], restock: true, reason: 'Wrong colour' }).expect(201)).body.data;
    id.cn = cn.id;
    expect(cn).toMatchObject({ doc_type: 'credit_note', grand_total: '4130.00' });
    expect(await onHand(c.w.db, id.board, c.m.showroom)).toBe(4);
    const p = (await accounts.get(`/api/parties/${id.rao}`).expect(200)).body.data;
    expect(Number(p.balance)).toBe(-4130);
    expect(await toCollect(c.w)).toEqual({});
    expect(await gst(c.w)).toMatchObject({ cgst: 315, sgst: 315 });
  });

  it('her next board is paid for out of that credit: nothing changes hands, the invoice shows paid', async () => {
    const inv = await sell(c, id.rao, id.board, 1, 'store');
    id.inv2 = inv.id;
    const accounts = await c.w.as('accounts');
    const credits = (await accounts.get(`/api/sales/invoices/${id.inv2}/credits`).expect(200)).body.data;
    expect(JSON.stringify(credits)).toContain(id.cn);
    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn }).expect(201);
    const p = (await accounts.get(`/api/parties/${id.rao}`).expect(200)).body.data;
    expect(Number(p.balance)).toBe(0);
    expect(p.open_invoices).toEqual([]);
    expect(acct(await books(c.w), 'Bank Account')).toBe(8260);
  });

  it('an invoice raised by mistake is cancelled: stock, what she owes, GST and sales all go back; its number stays used', async () => {
    const before = await books(c.w);
    const gstBefore = await gst(c.w);
    const inv = await sell(c, id.rao, id.board, 1, 'store');
    expect(inv.invoice_no).toMatch(/00003$/);
    expect(await toCollect(c.w)).toEqual({ 'Rao Sports': 4130 });
    const accounts = await c.w.as('accounts');
    const done = (await accounts.post(`/api/sales/invoices/${inv.id}/cancel`).send({ reason: 'Billed by mistake', restock: true }).expect(200)).body.data;
    expect(done.status).toBe('cancelled');
    expect(await onHand(c.w.db, id.board, c.m.showroom)).toBe(3);
    expect(await toCollect(c.w)).toEqual({});
    expect(await gst(c.w)).toEqual(gstBefore);
    const after = await books(c.w);
    for (const name of ['Sales', 'Cost of Goods Sold', 'Stock in Hand', 'Debtors (Accounts Receivable)', 'Output CGST', 'Output SGST']) {
      expect([name, acct(after, name)]).toEqual([name, acct(before, name)]);
    }
    const next = await sell(c, id.rao, id.board, 1, 'store');
    expect(next.invoice_no).toMatch(/00004$/); // a cancelled number is never handed out again
    await (await c.w.as('accounts')).post(`/api/sales/invoices/${next.id}/cancel`).send({ reason: 'Only to check the numbering', restock: true }).expect(200);
  });

  it('a receipt entered twice is cancelled: the bank and her balance go back, and the day book shows both', async () => {
    const accounts = await c.w.as('accounts');
    const r = (await accounts.post('/api/payments').send({ direction: 'in', party_id: id.rao, mode: 'upi', amount: 1000, reference: 'DUP' }).expect(201)).body.data;
    expect(acct(await books(c.w), 'Bank Account')).toBe(9260);
    expect(Number((await accounts.get(`/api/parties/${id.rao}`).expect(200)).body.data.balance)).toBe(-1000);
    await accounts.post(`/api/payments/${r.id}/cancel`).send({ reason: 'Entered twice' }).expect(200);
    expect(acct(await books(c.w), 'Bank Account')).toBe(8260);
    expect(Number((await accounts.get(`/api/parties/${id.rao}`).expect(200)).body.data.balance)).toBe(0);
    const day = (await accounts.get('/api/accounting/reports/day-book').query({ from: TODAY, to: TODAY }).expect(200)).body.data;
    expect(day.filter((e: any) => JSON.stringify(e).includes(r.payment_no)).length).toBeGreaterThanOrEqual(2);
  });

  it('a supplier bill entered wrongly is cancelled and entered again: the goods stay, only what we owe moves', async () => {
    id.supplier = await party(c, { party_type: 'supplier', name: 'Deck Makers', phone: '9700000001', gstin: gstin('27', 'SUPPL1234A') });
    const stores = await c.w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.supplier, lines: [{ item_id: id.board, qty: 5, rate: 2000 }] }).expect(201)).body.data;
    await stores.post(`/api/purchasing/orders/${po.id}/send`).send({}).expect(200);
    const poLine = (await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines[0].id;
    const grn = (await stores.post('/api/purchasing/receipts').send({ purchase_order_id: po.id, lines: [{ po_line_id: poLine, received_qty: 5 }] }).expect(201)).body.data;
    const grnLine = (await stores.get(`/api/purchasing/receipts/${grn.id}`).expect(200)).body.data.lines[0].id;
    await stores.post(`/api/purchasing/receipts/${grn.id}/qc`).send({ lines: [{ grn_line_id: grnLine, accepted_qty: 5, rejected_qty: 0 }] }).expect(200);
    const accounts = await c.w.as('accounts');
    const bill = (await accounts.post('/api/purchasing/bills').send({ supplier_id: id.supplier, purchase_order_id: po.id, supplier_invoice_no: 'DM/201', bill_date: TODAY, lines: [{ po_line_id: poLine, qty: 5, rate: 2000 }] }).expect(201)).body.data;
    let b = await books(c.w);
    expect([acct(b, 'Creditors (Accounts Payable)'), acct(b, 'Goods Received Not Billed'), acct(b, 'Input CGST') + acct(b, 'Input SGST')]).toEqual([-11800, 0, 1800]);
    await accounts.post(`/api/purchasing/bills/${bill.id}/cancel`).send({ reason: 'Wrong rate on their bill' }).expect(200);
    b = await books(c.w);
    expect([acct(b, 'Creditors (Accounts Payable)'), acct(b, 'Goods Received Not Billed'), acct(b, 'Input CGST') + acct(b, 'Input SGST')]).toEqual([0, -10000, 0]);
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(10); // 5 left from the opening 10, and the 5 received
    await accounts.post('/api/purchasing/bills').send({ supplier_id: id.supplier, purchase_order_id: po.id, supplier_invoice_no: 'DM/201', bill_date: TODAY, lines: [{ po_line_id: poLine, qty: 5, rate: 2000 }] }).expect(201);
    expect(acct(await books(c.w), 'Creditors (Accounts Payable)')).toBe(-11800);
  });

  it('after all that, every section agrees', async () => {
    // Boards: 10 + 5 bought - 2 - 1 - 1 - 1 sold + 1 returned + 1 + 1 cancelled = 13, all at 2,000.
    expect(await onHand(c.w.db, id.board, c.m.stores) + await onHand(c.w.db, id.board, c.m.showroom)).toBe(13);
    expect(await stockValue(c.w, id.board)).toBe(26000);
    const b = await books(c.w);
    expect(acct(b, 'Stock in Hand')).toBe(26000);
    expect(acct(b, 'Sales')).toBe(-7000); // 7,000 - 3,500 returned + 3,500 on the second invoice
    expect(acct(b, 'Cost of Goods Sold')).toBe(4000);
    expect(await profit(c.w)).toEqual({ income: 7000, expense: 4000, net: 3000 });
    expect(await gst(c.w)).toMatchObject({ cgst: 630, sgst: 630 });
    await expectBooksHealthy(c.w);
  });
});

// =====================================================================================================
describe('C. A stock count, closing the year, and the period lock', () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  const lastFy = fyOf(addDays(fyRange(fyOf(TODAY)).from, -1));
  const L = fyRange(lastFy);
  beforeAll(async () => { c = await start(); });
  afterAll(() => c.w.close());

  it('last year: the owner put in 1,00,000 and 12,000 went on rent. Closing the year moves the loss into Retained Earnings', async () => {
    const accounts = await c.w.as('accounts');
    const chart = (await accounts.get('/api/accounting/accounts').expect(200)).body.data;
    id.rent = chart.find((a: any) => a.name === 'Rent').id;
    await capital(c, 100000, addDays(L.from, 10));
    await accounts.post('/api/accounting/journals').send({
      entry_date: addDays(L.from, 40), narration: 'Rent', lines: [{ account_id: id.rent, debit: 12000 }, { account_id: c.m.account('bank'), credit: 12000 }],
    }).expect(201);
    const years = (await accounts.get('/api/accounting/years').expect(200)).body.data;
    expect(years.find((y: any) => y.fy === lastFy)).toMatchObject({ profit: '-12000.00', can_close: true });
    await accounts.post(`/api/accounting/years/${lastFy}/close`).send({}).expect(201);
    const b = await books(c.w);
    expect(acct(b, 'Retained Earnings')).toBe(12000); // a loss sits on the debit side
    expect(acct(b, 'Rent')).toBe(0);
    expect(await profit(c.w, L.from, L.to)).toMatchObject({ net: -12000 }); // the year's own report still shows what happened
    expect(await profit(c.w)).toMatchObject({ net: 0 }); // this year starts from nothing
    const late = await accounts.post('/api/accounting/journals').send({
      entry_date: addDays(L.to, -1), narration: 'Late rent', lines: [{ account_id: id.rent, debit: 100 }, { account_id: c.m.account('bank'), credit: 100 }],
    }).expect(409);
    expect(late.body.error.message).toMatch(/locked/);
  });

  it('a count finds 18 boards where the books say 20: nothing moves until it is approved, then stock and profit both take the loss', async () => {
    id.board = await board(c);
    await openingStock(c.w, c.m.stores, [{ item_id: id.board, qty_change: '20', unit_cost: '2000' }]);
    const count = (await (await c.w.as('stores')).post('/api/stock/counts').send({ location_id: c.m.stores, reason: 'Month-end count', lines: [{ item_id: id.board, counted_qty: 18 }] }).expect(201)).body.data;
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(20);
    await (await c.w.as('stores')).post(`/api/stock/adjustments/${count.id}/approve`).send({}).expect(403); // only the owner or an admin approves a count
    await (await c.w.as('owner')).post(`/api/stock/adjustments/${count.id}/approve`).send({}).expect(200);
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(18);
    expect(await stockValue(c.w, id.board)).toBe(36000);
    const b = await books(c.w);
    expect(acct(b, 'Stock in Hand')).toBe(36000);
    expect(acct(b, 'Stock Adjustment')).toBe(4000);
    expect(await profit(c.w)).toEqual({ income: 0, expense: 4000, net: -4000 });
  });

  it('once a month is locked, nothing dated in it can be entered; today still can', async () => {
    const accounts = await c.w.as('accounts');
    await accounts.put('/api/settings/period-lock').send({ period_lock_date: YESTERDAY }).expect(200);
    const expense = (date: string) => accounts.post('/api/accounting/expenses').send({
      expense_date: date, category_id: c.m.expenseCategory('Rent'), amount: 500, paid_from_account_id: c.m.account('bank'), vendor_name: 'Landlord',
    });
    expect((await expense(YESTERDAY).expect(409)).body.error.message).toMatch(/locked/);
    await expense(TODAY).expect(201);
    // The lock cannot go back into the year closed above: that would reopen it with one person.
    const closed = (await accounts.get('/api/accounting/years').expect(200)).body.data.find((y: { status: string }) => y.status === 'closed');
    expect((await accounts.put('/api/settings/period-lock').send({ period_lock_date: null }).expect(403)).body.error.message).toMatch(/closed year/);
    await accounts.put('/api/settings/period-lock').send({ period_lock_date: closed.to }).expect(200);
    await expectBooksHealthy(c.w);
  });
});

// =====================================================================================================
describe('D. Job work feeding into the cost of a sale, and an Amazon order', () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  let away = '';
  beforeAll(async () => {
    c = await start();
    id.board = await board(c);
    id.charges = (await (await c.w.as('admin')).post('/api/items').send({ sku: 'JW-CHG', name: 'Job work charges', item_type: 'service', hsn_sac: '998898', gst_rate: 18 }).expect(201)).body.data.id;
    await openingStock(c.w, c.m.stores, [{ item_id: id.board, qty_change: '20', unit_cost: '2000' }]);
    id.worker = await party(c, { party_type: 'supplier', name: 'Grip Tape Works', phone: '9700000009', gstin: gstin('27', 'GRIPT1234C') });
    away = (await rows<{ id: string }>(c.w.db, sql`select id from locations where type = 'job_work'`))[0]!.id;
  });
  afterAll(() => c.w.close());

  it('4 boards go out for grip tape: they leave the shelf but stay ours, at the same value, with nothing in the books', async () => {
    const before = await books(c.w);
    const job = (await (await c.w.as('stores')).post('/api/jobwork').send({ job_worker_id: id.worker, from_location_id: c.m.stores, challan_date: TODAY, process: 'Grip taping', lines: [{ item_id: id.board, qty: 4 }] }).expect(201)).body.data;
    id.job = job.id;
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(16);
    expect(await onHand(c.w.db, id.board, away)).toBe(4);
    expect(await stockValue(c.w, id.board)).toBe(40000);
    expect(await books(c.w)).toEqual(before);
    // Nothing but the challan can move them while they are out.
    await (await c.w.as('stores')).post('/api/stock/transfers').send({ from_location_id: away, to_location_id: c.m.stores, reason: 'x', lines: [{ item_id: id.board, qty: 1 }] }).expect(400);
  });

  it('they come back with a 400 charge: the boards are worth 400 more, and 400 is owed to the worker until his bill comes', async () => {
    const stores = await c.w.as('stores');
    const line = (await stores.get(`/api/jobwork/${id.job}`).expect(200)).body.data.lines[0].id;
    await stores.post(`/api/jobwork/${id.job}/receipts`).send({ received_on: TODAY, to_location_id: c.m.stores, worker_challan_no: 'GT/7', charge: 400, lines: [{ line_id: line, returned: 4 }] }).expect(201);
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(20);
    expect(await onHand(c.w.db, id.board, away)).toBe(0);
    expect(await stockValue(c.w, id.board)).toBe(40400);
    const b = await books(c.w);
    expect(acct(b, 'Stock in Hand')).toBe(40400);
    expect(acct(b, 'Job Work Charges to be Billed')).toBe(-400);
    expect((await stores.get(`/api/jobwork/${id.job}`).expect(200)).body.data.status).toBe('closed');
  });

  it("his bill for 400 + GST settles what was owed: nothing is counted twice as an expense", async () => {
    const bill = (await (await c.w.as('accounts')).post('/api/purchasing/bills').send({
      supplier_id: id.worker, bill_date: TODAY, supplier_invoice_no: 'GT/INV/7', job_work_id: id.job, lines: [{ item_id: id.charges, qty: 1, rate: 400 }],
    }).expect(201)).body.data;
    expect(bill).toMatchObject({ grand_total: '472.00', job_work_cleared: '400.00' });
    const b = await books(c.w);
    expect(acct(b, 'Job Work Charges to be Billed')).toBe(0);
    expect(acct(b, 'Purchases (Non-stock)')).toBe(0);
    expect(acct(b, 'Creditors (Accounts Payable)')).toBe(-472);
    expect(acct(b, 'Input CGST') + acct(b, 'Input SGST')).toBe(72);
  });

  it('a board sold at the counter now costs 2,020: the grip tape charge has reached the cost of the sale', async () => {
    await (await c.w.as('stores')).post('/api/stock/transfers').send({ from_location_id: c.m.stores, to_location_id: c.m.showroom, reason: 'Display', lines: [{ item_id: id.board, qty: 1 }] }).expect(201);
    const sold = (await (await c.w.as('store')).post('/api/sales/quick-bill').send({ lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'upi', amount: 4130, reference: 'UPI-1' }] }).expect(201)).body.data;
    expect(sold.invoice.grand_total).toBe('4130.00');
    expect(acct(await books(c.w), 'Cost of Goods Sold')).toBe(2020);
  });

  it('an Amazon order report brings in an order for 2 boards; delivered and invoiced, it is Amazon that owes us', async () => {
    const report = [
      'amazon-order-id\tpurchase-date\torder-status\tsku\tproduct-name\tquantity\titem-price\tshipping-price\tship-city\tship-state\tship-postal-code\trecipient-name',
      `402-9000000-0000001\t${TODAY}T09:45:00+05:30\tShipped\tBRD-1\tCruiser Board\t2\t8260.00\t0\tPune\tMAHARASHTRA\t411001\tRohit K`,
    ].join('\n');
    const sales = await c.w.as('sales');
    expect((await sales.post('/api/sales/online/import').send({ channel: 'amazon', file: report }).expect(201)).body.data).toMatchObject({ orders: 1, taken_in: 1 });
    expect((await sales.post('/api/sales/online/import').send({ channel: 'amazon', file: report }).expect(201)).body.data).toMatchObject({ taken_in: 0, already_here: 1 });
    const order = (await sales.get('/api/sales/orders').query({ limit: 50 }).expect(200)).body.data.find((o: any) => o.channel === 'amazon');
    expect(order.status).toBe('confirmed');
    await sales.post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(201);
    const inv = (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({}).expect(201)).body.data;
    expect(inv).toMatchObject({ taxable_total: '7000.00', grand_total: '8260.00' });
    expect(await toCollect(c.w)).toEqual({ 'Amazon marketplace': 8260 });
    expect(await onHand(c.w.db, id.board, c.m.stores)).toBe(17);
    const b = await books(c.w);
    expect(acct(b, 'Cost of Goods Sold')).toBe(6060); // 2,020 + 2 x 2,020
    expect(await stockValue(c.w, id.board)).toBe(34340); // 17 boards at 2,020
    expect(acct(b, 'Stock in Hand')).toBe(34340);
    await expectBooksHealthy(c.w);
  });
});

// =====================================================================================================
describe("E. A month's salary with PF, ESIC, professional tax, leave and an advance", () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  const monthStart = `${addDays(`${TODAY.slice(0, 7)}-01`, -1).slice(0, 7)}-01`; // the first of last month
  const month = monthStart.slice(0, 7);
  beforeAll(async () => {
    c = await start();
    await capital(c, 100000);
    const [u] = await rows<{ id: string }>(c.w.db, sql`select id from users where role = 'stores'`);
    id.user = u!.id;
  });
  afterAll(() => c.w.close());

  it('Meera is on 20,000 a month, with PF, ESIC and 200 professional tax; she took a 3,000 advance, 1,000 a month to come back', async () => {
    const admin = await c.w.as('admin');
    id.meera = (await admin.post('/api/hr/employees').send({
      name: 'Meera Joshi', phone: '9833000002', department: 'Stores', designation: 'Stores Assistant', join_date: addDays(monthStart, -60), monthly_salary: 20000, user_id: id.user,
    }).expect(201)).body.data.id;
    await admin.put(`/api/payroll/staff/${id.meera}`).send({ monthly_salary: 20000, pf_applicable: true, esic_applicable: true, pt_monthly: 200, tds_monthly: 0, bank_account_no: '', bank_ifsc: '' }).expect(200);
    await (await c.w.as('accounts')).post('/api/payroll/advances').send({
      employee_id: id.meera, amount: 3000, monthly_recovery: 1000, given_on: monthStart, paid_from_account_id: c.m.account('bank'), note: 'Medical',
    }).expect(201);
    const b = await books(c.w);
    expect(acct(b, 'Staff Advances')).toBe(3000);
    expect(acct(b, 'Bank Account')).toBe(97000);
  });

  it('last month in the register: present every working day but two days of paid leave; Sundays need no marking', async () => {
    const hr = await c.w.as('hr');
    let leave = 0;
    for (let d = monthStart; d.slice(0, 7) === month; d = addDays(d, 1)) {
      if (weekdayOf(d) === 0) continue;
      const status = leave < 2 ? 'leave' : 'present';
      if (status === 'leave') leave++;
      await hr.put('/api/hr/attendance').send({ date: d, entries: [{ employee_id: id.meera, status }] }).expect(200);
    }
    expect(leave).toBe(2);
  });

  it('the payslip: 20,000 earned, PF 1,200, ESIC 150, PT 200, advance 1,000, so 17,450 to her', async () => {
    const accounts = await c.w.as('accounts');
    id.run = (await accounts.post('/api/payroll/runs').send({ month }).expect(201)).body.data.id;
    const slip = (await accounts.get(`/api/payroll/runs/${id.run}`).expect(200)).body.data.payslips[0];
    expect(slip).toMatchObject({
      gross_earned: '20000.00', pf_employee: '1200.00', pf_employer: '1200.00', esic_employee: '150.00', esic_employer: '650.00',
      pt: '200.00', advance_recovery: '1000.00', net_pay: '17450.00',
    });
  });

  it('approving the month puts it in the books: the company’s cost, and every amount owed to her, to PF, ESIC and the state', async () => {
    await (await c.w.as('accounts')).post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(200);
    const b = await books(c.w);
    expect(acct(b, 'Salaries & Wages')).toBe(21850); // 20,000 + the company's PF 1,200 and ESIC 650
    expect(acct(b, 'PF Payable')).toBe(-2400);
    expect(acct(b, 'ESIC Payable')).toBe(-800);
    expect(acct(b, 'Professional Tax Payable')).toBe(-200);
    expect(acct(b, 'Staff Advances')).toBe(2000);
    expect(acct(b, 'Salaries Payable')).toBe(-17450);
    const staff = (await (await c.w.as('accounts')).get('/api/payroll/staff').expect(200)).body.data.find((e: any) => e.name === 'Meera Joshi');
    expect(staff.advance_outstanding).toBe('2000.00');
  });

  it('paying it clears what is owed to her and takes 17,450 out of the bank', async () => {
    await (await c.w.as('accounts')).post(`/api/payroll/runs/${id.run}/pay`).send({ paid_from_account_id: c.m.account('bank') }).expect(200);
    const b = await books(c.w);
    expect(acct(b, 'Salaries Payable')).toBe(0);
    expect(acct(b, 'Bank Account')).toBe(79550); // 1,00,000 - 3,000 advance - 17,450
    await expectBooksHealthy(c.w);
  });

  it('when she asks for leave herself and HR approves, it goes into the register and comes off her balance', async () => {
    const hr = await c.w.as('hr');
    const balance = async () => (await hr.get('/api/hr/leave-balances').expect(200)).body.data.find((e: any) => e.name === 'Meera Joshi');
    const before = await balance();
    let monday = addDays(TODAY, 7);
    while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
    const asked = (await (await c.w.as('stores')).post('/api/hr/me/leave').send({ from: monday, to: addDays(monday, 1), reason: 'Family function' }).expect(201)).body.data;
    expect(asked).toMatchObject({ status: 'pending', days: 2 });
    await hr.post(`/api/hr/leave-requests/${asked.id}/decide`).send({ approve: true }).expect(200);
    const day = (await hr.get('/api/hr/attendance').query({ date: monday }).expect(200)).body.data.find((e: any) => e.name === 'Meera Joshi');
    expect(day.status).toBe('leave');
    if (fyOf(monday) === fyOf(TODAY)) expect((await balance()).taken).toBe(before.taken + 2);
  });
});

// =====================================================================================================
describe('F. Leads: repeats, turns, plans, lost and back, imports, and what marketing sees', () => {
  let c: Ctx;
  const id: Record<string, any> = {};
  let token = '';
  beforeAll(async () => {
    c = await start();
    // A second salesperson, so leads can be shared out in turn.
    id.ravi = (await (await c.w.as('admin')).post('/api/users').send({ name: 'Ravi Sales', phone: '9811122233', role: 'sales', password: 'Second-sales-1' }).expect(201)).body.data.id;
    token = (await (await c.w.as('marketing')).post('/api/masters/campaigns').send({ name: 'Website form', source_id: c.m.source('Website') }).expect(201)).body.data.token;
  });
  afterAll(() => c.w.close());
  const lead = async (leadId: string) => (await (await c.w.as('marketing')).get(`/api/leads/${leadId}`).expect(200)).body.data;
  const leadsNow = async () => (await (await c.w.as('marketing')).get('/api/leads').query({ limit: 100 }).expect(200)).body.data as any[];

  it('the same person enquiring twice is one lead with two enquiries on it; two different people go to the two salespeople in turn', async () => {
    await request(c.w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Priya Nair', phone: '9840000001', message: 'Price of the cruiser?' }).expect(201);
    await request(c.w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Priya Nair', phone: '+91 98400 00001', message: 'Any discount?' }).expect(201);
    await request(c.w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Arjun Das', phone: '9840000002', message: 'Do you deliver?' }).expect(201);
    const all = await leadsNow();
    expect(all).toHaveLength(2);
    id.priya = all.find((l) => l.name === 'Priya Nair').id;
    id.arjun = all.find((l) => l.name === 'Arjun Das').id;
    const priya = await lead(id.priya);
    expect(priya.activities.filter((a: any) => a.type === 'enquiry')).toHaveLength(2);
    expect(new Set(all.map((l) => l.owner_id)).size).toBe(2);
  });

  it('on a two-step plan, contacting her on the first step moves her follow-up to the second step, two days on', async () => {
    const marketing = await c.w.as('marketing');
    const plan = (await marketing.post('/api/leads/plans').send({ name: 'New enquiry', steps: [{ after_days: 0, what: 'First hello' }, { after_days: 2, what: 'Follow up' }] }).expect(201)).body.data;
    await marketing.post(`/api/leads/${id.priya}/plan`).send({ plan_id: plan.id }).expect(200);
    expect((await lead(id.priya)).plan_step).toBe(0);
    await (await c.w.as('sales')).post(`/api/crm/leads/${id.priya}/contact`).send({ channel: 'whatsapp' }).expect(200);
    const after = await lead(id.priya);
    expect(after.stage).toBe('contacted');
    expect(after.plan_step).toBe(1);
    expect(new Date(after.next_follow_up_at).getTime()).toBeGreaterThan(Date.now() + 36 * 3600_000);
  });

  it('a lost lead needs a reason and has no follow-up; brought back, it needs one again', async () => {
    const marketing = await c.w.as('marketing');
    await marketing.post(`/api/leads/${id.arjun}/stage`).send({ stage: 'lost' }).expect(400);
    await marketing.post(`/api/leads/${id.arjun}/stage`).send({ stage: 'lost', lost_reason_id: c.m.lostReason('Price') }).expect(200);
    expect(await lead(id.arjun)).toMatchObject({ stage: 'lost', next_follow_up_at: null });
    await marketing.post(`/api/leads/${id.arjun}/stage`).send({ stage: 'contacted', next_follow_up_at: '' }).expect(400);
    await marketing.post(`/api/leads/${id.arjun}/stage`).send({ stage: 'contacted', next_follow_up_at: `${addDays(TODAY, 3)}T10:00:00+05:30` }).expect(200);
    expect((await lead(id.arjun)).stage).toBe('contacted');
  });

  it('a spreadsheet of three: one new, one already a lead, one with a bad number; the new one is handed to Ravi', async () => {
    const marketing = await c.w.as('marketing');
    const csv = 'Name,Phone,City\nNeha Shah,9840000003,Pune\nPriya Nair,9840000001,Pune\nNo Number,12345,Pune\n';
    const out = (await marketing.post('/api/leads/import').send({ csv, source_id: c.m.source('Website') }).expect(201)).body.data;
    expect(out).toMatchObject({ rows: 3, added: 1, already_here: 1 });
    expect(out.problems).toHaveLength(1);
    const neha = (await leadsNow()).find((l) => l.name === 'Neha Shah');
    expect((await marketing.post('/api/leads/bulk-assign').send({ ids: [neha.id], owner_id: id.ravi }).expect(200)).body.data.moved).toBe(1);
    expect((await lead(neha.id)).owner_id).toBe(id.ravi);
  });

  it('Priya buys: the sale is credited to the Website, and the ad spend becomes a cost per lead', async () => {
    const sales = await c.w.as('sales');
    const boardId = await board(c);
    await openingStock(c.w, c.m.showroom, [{ item_id: boardId, qty_change: '5', unit_cost: '2000' }]);
    const won = (await sales.post(`/api/leads/${id.priya}/convert`).send({ party_type: 'customer' }).expect(200)).body.data;
    await (await c.w.as('store')).post('/api/sales/quick-bill').send({ party_id: won.party.id, lines: [{ item_id: boardId, qty: 1 }], payments: [{ mode: 'upi', amount: 4130 }] }).expect(201);
    await (await c.w.as('marketing')).post('/api/crm/spend').send({ source_id: c.m.source('Website'), spend_date: TODAY, amount: 3000 }).expect(201);
    const dash = (await (await c.w.as('marketing')).get('/api/dashboards/marketing').expect(200)).body.data;
    const web = dash.by_source.find((s: any) => s.source === 'Website');
    expect(web).toMatchObject({ leads: 3, converted: 1, spend: '3000.00', cost_per_lead: '1000.00', cost_per_conversion: '3000.00' });
    expect(Number(web.revenue)).toBe(4130);
  });
});
