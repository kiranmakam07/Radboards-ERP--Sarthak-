import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { tdsDueOn } from '../src/modules/tds';
import { expectBooksHealthy, gstin, masters, openingStock, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const today = istDate();
const month = today.slice(0, 7);

/** Balance of a system account: positive = debit. */
const balance = async (key: string) =>
  Number((await rows<{ b: string }>(w.db, sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.system_key = ${key}`))[0]!.b);

/** Sell to a dealer on credit, invoiced today. Returns the invoice. */
const sellOnCredit = async (partyId: string, itemId: string, qty: number) => {
  const sales = await w.as('sales');
  const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: partyId, order_date: today, lines: [{ item_id: itemId, qty }] }).expect(201)).body.data;
  await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
  await (await w.as('stores')).post(`/api/sales/orders/${order.id}/deliver`).send({ location_id: m.stores }).expect(201);
  return (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({ invoice_date: today }).expect(201)).body.data;
};
const rate = async (name: string) =>
  (await (await w.as('accounts')).get('/api/tds/rates').expect(200)).body.data.find((r: any) => r.name === name).id as string;

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const item = async (body: Record<string, unknown>) => (await admin.post('/api/items').send({ gst_rate: 18, ...body }).expect(201)).body.data.id as string;
  // Board: sold to dealers at 1,000 before GST, costs 500. Wheels: 800 before 12% GST, cost 500.
  id.board = await item({ sku: 'BRD-1', name: 'Board', item_type: 'finished_good', hsn_sac: '950699', retail_price: 1180, dealer_price: 1000, purchase_cost: 500 });
  id.wheels = await item({ sku: 'WHL-1', name: 'Wheels', item_type: 'spare_part', hsn_sac: '871499', gst_rate: 12, retail_price: 1120, dealer_price: 800, purchase_cost: 500 });
  id.job = await item({ sku: 'JOB-1', name: 'Fabrication job work', item_type: 'service', hsn_sac: '998873' });
  await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '100', unit_cost: '500.00' }, { item_id: id.wheels!, qty_change: '50', unit_cost: '500.00' }]);
  const party = async (body: Record<string, unknown>) => (await admin.post('/api/parties').send(body).expect(201)).body.data;
  id.bangalore = (await party({ party_type: 'dealer', name: 'Bangalore Boards', phone: '9700000002', gstin: gstin('29', 'DEALR1234B'), payment_terms_days: 15 })).id;
  id.mumbai = (await party({ party_type: 'dealer', name: 'Mumbai Skate Co', phone: '9700000003', gstin: gstin('27', 'DEALR5678C') })).id;
  // The fabricator is registered, so the PAN on the TDS return is read out of the GSTIN.
  id.fabricator = (await party({ party_type: 'supplier', name: 'Sharma Fabricators', phone: '9700000004', gstin: gstin('27', 'ABCPS1234K') })).id;
  // Money to work with: the owner puts 5,00,000 in the bank.
  await (await w.as('accounts')).post('/api/accounting/journals').send({
    entry_date: today, narration: 'Capital brought in',
    lines: [{ account_id: m.account('bank'), debit: 500000 }, { account_id: m.account('capital'), credit: 500000 }],
  }).expect(201);
});
afterAll(() => w.close());

describe('profit by customer and sales by HSN', () => {
  it('adds each customer’s bills up, takes returns off, and agrees with profit by bill', async () => {
    const accounts = await w.as('accounts');
    // Bangalore: 10 boards = 10,000 + 1,800 IGST. Mumbai: 4 wheels = 3,200 + 384. Counter: 2 boards = 2,000 + 360, paid in cash.
    id.inv = (await sellOnCredit(id.bangalore!, id.board!, 10)).id;
    await sellOnCredit(id.mumbai!, id.wheels!, 4);
    await (await w.as('store')).post('/api/sales/quick-bill').send({ location_id: m.stores, lines: [{ item_id: id.board, qty: 2 }], payments: [{ mode: 'cash', amount: 2360 }] }).expect(201);
    // Bangalore sends one board back: 1,000 of sale and 500 of cost come off.
    const line = (await accounts.get(`/api/sales/invoices/${id.inv}`).expect(200)).body.data.lines[0];
    await accounts.post(`/api/sales/invoices/${id.inv}/credit-note`).send({ lines: [{ invoice_line_id: line.id, qty: 1 }], restock: true, reason: 'Transit damage' }).expect(201);

    const res = (await accounts.get(`/api/accounting/reports/party-profit?from=${today}&to=${today}`).expect(200)).body;
    expect(res.data.map((r: any) => [r.party_name, r.bills, r.returns, r.sale, r.cost, r.profit, Number(r.margin_pct)])).toEqual([
      ['Bangalore Boards', 1, 1, '9000.00', '4500.00', '4500.00', 50],
      ['Mumbai Skate Co', 1, 0, '3200.00', '2000.00', '1200.00', 37.5],
      ['Cash Sale', 1, 0, '2000.00', '1000.00', '1000.00', 50],
    ]);
    expect(res.totals).toEqual({ sale: '14200.00', cost: '7500.00', profit: '6700.00' });
    const byBill = (await accounts.get(`/api/accounting/reports/invoice-profit?from=${today}&to=${today}`).expect(200)).body;
    expect(byBill.totals).toEqual(res.totals);
    // Nothing was billed yesterday.
    expect((await accounts.get(`/api/accounting/reports/party-profit?from=${addDays(today, -1)}&to=${addDays(today, -1)}`).expect(200)).body.data).toEqual([]);
    await (await w.as('sales')).get('/api/accounting/reports/party-profit').expect(403);
  });

  it('shows what was sold under each HSN code, net of the return', async () => {
    const hsn = (await (await w.as('accounts')).get(`/api/gst/gstr1?section=hsn&from=${today}&to=${today}`).expect(200)).body.data;
    expect(hsn.map((r: any) => [r.hsn, Number(r.rate), Number(r.total_qty), Number(r.taxable_value), Number(r.igst), Number(r.cgst)])).toEqual([
      ['871499', 12, 4, 3200, 0, 192], // Mumbai is in our state: 384 split in two
      ['950699', 18, 11, 11000, 1620, 180], // 10 - 1 to Bangalore (IGST 1,620) and 2 over the counter (CGST 180)
    ]);
  });
});

describe('TDS we hold back', () => {
  it('starts with the usual kinds of payment, which accounts can change', async () => {
    const accounts = await w.as('accounts');
    const list = (await accounts.get('/api/tds/rates').expect(200)).body.data;
    expect(list.map((r: any) => [r.name, Number(r.rate)])).toEqual([
      ['Commission or brokerage', 2], ['Contractor (company or firm)', 2], ['Contractor (individual or HUF)', 1], ['Professional fees', 10],
      ['Purchase of goods', 0.1], ['Rent of land, building or furniture', 10], ['Rent of plant or machinery', 2], ['Technical services', 2],
    ]);
    const added = (await accounts.post('/api/tds/rates').send({ name: 'Interest on a loan', rate: 10, law_reference: 'Section 393(1)' }).expect(201)).body.data;
    await accounts.post('/api/tds/rates').send({ name: 'interest on a loan', rate: 5 }).expect(409);
    await accounts.post('/api/tds/rates').send({ name: 'Free money', rate: 0 }).expect(400);
    expect((await accounts.patch(`/api/tds/rates/${added.id}`).send({ return_code: '1011', active: false }).expect(200)).body.data).toMatchObject({ return_code: '1011', active: false, rate: '10.00' });
    await (await w.as('stores')).post('/api/tds/rates').send({ name: 'x', rate: 1 }).expect(403);
  });

  it('pays a supplier less the TDS, settles the bill in full, and owes the TDS to the government', async () => {
    const accounts = await w.as('accounts');
    // Job work 50,000 + 18% GST = 59,000. TDS is 1% of the 50,000, not of the GST: 500.
    const bill = (await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.fabricator, supplier_invoice_no: 'SF/77', bill_date: today, lines: [{ item_id: id.job, qty: 1, rate: 50000 }],
    }).expect(201)).body.data;
    expect(bill.grand_total).toBe('59000.00');
    const contractor = await rate('Contractor (individual or HUF)');
    const pay = (body: Record<string, unknown>) => accounts.post('/api/payments').send({ direction: 'out', party_id: id.fabricator, mode: 'bank_transfer', paid_on: today, ...body });

    // 58,500 on its own does not cover a 59,000 bill; nor can TDS be entered without saying what it is for.
    await pay({ amount: 58500, allocations: [{ purchase_bill_id: bill.id, amount: 59000 }] }).expect(400);
    expect((await pay({ amount: 58500, tds_amount: 500 }).expect(400)).body.error.message).toMatch(/kind of payment/);
    await pay({ amount: 58500, tds_rate_id: contractor }).expect(400);
    await pay({ amount: 100, tds_amount: 500, tds_rate_id: contractor, tds_base: 400 }).expect(400); // more TDS than the amount it is on
    await accounts.post('/api/payments').send({ direction: 'out', party_id: id.bangalore, mode: 'bank_transfer', amount: 100, tds_amount: 10, tds_rate_id: contractor }).expect(400);

    const paid = (await pay({ amount: 58500, tds_amount: 500, tds_rate_id: contractor, tds_base: 50000, reference: 'UTR123', allocations: [{ purchase_bill_id: bill.id, amount: 59000 }] }).expect(201)).body.data;
    expect(paid).toMatchObject({ amount: '58500.00', tds_amount: '500.00', tds_base: '50000.00' });
    expect(await balance('tds_payable_vendors')).toBe(-500);
    expect(await balance('bank')).toBe(500000 - 58500);
    const party = (await accounts.get(`/api/parties/${id.fabricator}`).expect(200)).body.data;
    expect(party).toMatchObject({ balance: '0.00', open_bills: [] });
    const listed = (await accounts.get(`/api/payments?party_id=${id.fabricator}`).expect(200)).body.data[0];
    expect(listed).toMatchObject({ unallocated: '0.00', tds_rate_name: 'Contractor (individual or HUF)' });

    // An advance with TDS, entered by mistake and cancelled: the TDS goes with it.
    const advance = (await pay({ amount: 9900, tds_amount: 100, tds_rate_id: contractor, tds_base: 10000 }).expect(201)).body.data;
    expect(await balance('tds_payable_vendors')).toBe(-600);
    await accounts.post(`/api/payments/${advance.id}/cancel`).send({ reason: 'Entered twice' }).expect(200);
    expect(await balance('tds_payable_vendors')).toBe(-500);
    expect(await balance('bank')).toBe(500000 - 58500);
  });

  it('holds TDS back on an expense such as rent, and pays the landlord the rest', async () => {
    const accounts = await w.as('accounts');
    const rent = await rate('Rent of land, building or furniture');
    const expense = (body: Record<string, unknown>) => accounts.post('/api/accounting/expenses').send({
      category_id: m.expenseCategory('Rent'), amount: 40000, paid_from_account_id: m.account('bank'), expense_date: today, ...body,
    });
    await expense({ tds_amount: 4000, tds_rate_id: rent }).expect(400); // who was it held back from?
    await expense({ vendor_name: 'R K Properties', tds_amount: 4000 }).expect(400); // what for?
    await expense({ vendor_name: 'R K Properties', tds_amount: 4000, tds_rate_id: rent, vendor_pan: 'NOT-A-PAN' }).expect(400);
    await expense({ vendor_name: 'R K Properties', tds_amount: 40000, tds_rate_id: rent }).expect(400);
    const done = (await expense({ vendor_name: 'R K Properties', tds_amount: 4000, tds_rate_id: rent, vendor_pan: 'aaapk1234l' }).expect(201)).body.data;
    expect(done).toMatchObject({ amount: '40000.00', tds_amount: '4000.00', vendor_pan: 'AAAPK1234L' });
    // Rent 40,000 in the books; 36,000 left the bank; 4,000 more is owed as TDS.
    expect(await balance('bank')).toBe(500000 - 58500 - 36000);
    expect(await balance('tds_payable_vendors')).toBe(-4500);
    const listed = (await accounts.get('/api/accounting/expenses').expect(200)).body.data[0];
    expect(listed).toMatchObject({ total: '40000.00', paid: '36000.00', tds_rate_name: 'Rent of land, building or furniture' });
  });

  it('reports what was held back: each deduction, by kind and by month with its due date', async () => {
    const accounts = await w.as('accounts');
    const res = (await accounts.get(`/api/tds/payable?from=${today}&to=${today}`).expect(200)).body;
    expect(res.data.map((d: any) => [d.source, d.deductee, d.pan, d.kind, Number(d.rate), d.base, d.tds])).toEqual(expect.arrayContaining([
      ['payment', 'Sharma Fabricators', 'ABCPS1234K', 'Contractor (individual or HUF)', 1, '50000.00', '500.00'],
      ['expense', 'R K Properties', 'AAAPK1234L', 'Rent of land, building or furniture', 10, '40000.00', '4000.00'],
    ]));
    expect(res.data).toHaveLength(2); // the cancelled advance is not a deduction
    expect(res.by_kind.map((k: any) => [k.kind, k.entries, k.base, k.tds])).toEqual([
      ['Contractor (individual or HUF)', 1, '50000.00', '500.00'], ['Rent of land, building or furniture', 1, '40000.00', '4000.00'],
    ]);
    expect(res.by_month).toEqual([{ month, deducted: '4500.00', deposited: '0.00', left: '4500.00', due_on: tdsDueOn(month), overdue: false }]);
    expect(res.totals).toEqual({ base: '90000.00', tds: '4500.00', deposited: '0.00' });
    expect(res.owed_now).toEqual({ vendor: '4500.00', salary: '0.00' });
    for (const role of ['sales', 'stores', 'hr'] as const) await (await w.as(role)).get('/api/tds/payable').expect(403);
    await (await w.as('owner')).get('/api/tds/payable').expect(200);
  });

  it('knows when a month’s TDS is due', () => {
    expect(tdsDueOn('2026-10')).toBe('2026-11-07');
    expect(tdsDueOn('2026-12')).toBe('2027-01-07');
    expect(tdsDueOn('2027-03')).toBe('2027-04-30');
  });

  it('records paying it over, never more than is owed, and can undo a deposit', async () => {
    const accounts = await w.as('accounts');
    const deposit = (body: Record<string, unknown>) => accounts.post('/api/tds/deposits').send({ account_id: m.account('bank'), month, paid_on: today, ...body });
    expect((await deposit({ amount: 5000 }).expect(409)).body.error.message).toMatch(/Only 4500\.00/);
    expect((await deposit({ amount: 100, kind: 'salary' }).expect(409)).body.error.message).toMatch(/No TDS is owed/);
    await deposit({ amount: 4500, month: addMonths(`${month}-01`, 1).slice(0, 7) }).expect(400); // a month that has not ended
    await deposit({ amount: 4500, account_id: m.account('creditors') }).expect(409); // not a cash or bank account
    await (await w.as('owner')).post('/api/tds/deposits').send({ account_id: m.account('bank'), month, amount: 4500 }).expect(403);

    const first = (await deposit({ amount: 4500, challan_no: '00123', bsr_code: '0510308' }).expect(201)).body.data;
    expect(await balance('tds_payable_vendors')).toBe(0);
    expect(await balance('bank')).toBe(500000 - 58500 - 36000 - 4500);
    await deposit({ amount: 1 }).expect(409); // nothing left to pay

    await accounts.post(`/api/tds/deposits/${first.id}/cancel`).send({ reason: 'Wrong challan' }).expect(200);
    await accounts.post(`/api/tds/deposits/${first.id}/cancel`).send({ reason: 'again' }).expect(409);
    expect(await balance('tds_payable_vendors')).toBe(-4500);
    await deposit({ amount: 4500, challan_no: '00124' }).expect(201);

    const res = (await accounts.get(`/api/tds/payable?from=${today}&to=${today}`).expect(200)).body;
    expect(res.by_month[0]).toMatchObject({ deducted: '4500.00', deposited: '4500.00', left: '0.00', overdue: false });
    expect(res.owed_now.vendor).toBe('0.00');
    const list = (await accounts.get('/api/tds/deposits').expect(200)).body.data;
    expect(list.map((d: any) => [d.challan_no, d.status, d.amount, d.account_name])).toEqual([['00124', 'posted', '4500.00', 'Bank Account'], ['00123', 'cancelled', '4500.00', 'Bank Account']]);
  });
});

describe('TDS customers hold back from us', () => {
  it('settles the invoice in full although less money arrived, and keeps the TDS as tax already paid', async () => {
    const accounts = await w.as('accounts');
    // Bangalore owes 11,800 less the 1,180 return = 10,620. They hold back 0.1% of the 9,000 goods value: 9.
    const open = (await accounts.get(`/api/parties/${id.bangalore}`).expect(200)).body.data.open_invoices;
    expect(open.map((i: any) => i.outstanding)).toEqual(['10620.00']);
    const goods = await rate('Purchase of goods');
    const receipt = (await accounts.post('/api/payments').send({
      direction: 'in', party_id: id.bangalore, mode: 'bank_transfer', amount: 10611, tds_amount: 9, tds_rate_id: goods, tds_base: 9000, paid_on: today,
      allocations: [{ invoice_id: id.inv, amount: 10620 }],
    }).expect(201)).body.data;
    expect(receipt).toMatchObject({ amount: '10611.00', tds_amount: '9.00' });
    expect(await balance('tds_receivable')).toBe(9);
    expect(await balance('bank')).toBe(500000 - 58500 - 36000 - 4500 + 10611);
    expect((await accounts.get(`/api/parties/${id.bangalore}`).expect(200)).body.data).toMatchObject({ balance: '0.00', open_invoices: [] });

    const res = (await accounts.get(`/api/tds/receivable?from=${today}&to=${today}`).expect(200)).body;
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ customer: 'Bangalore Boards', pan: 'DEALR1234B', kind: 'Purchase of goods', gross: '10620.00', received: '10611.00', tds: '9.00' });
    expect(res.data[0].invoices).toMatch(/^INV\//);
    expect(res.by_customer).toEqual([{ customer: 'Bangalore Boards', pan: 'DEALR1234B', receipts: 1, gross: '10620.00', tds: '9.00' }]);
    expect(res.totals).toEqual({ gross: '10620.00', received: '10611.00', tds: '9.00' });
    expect(res.balance_now).toBe('9.00');
    // A customer need not say which kind of payment it was for them.
    await accounts.post('/api/payments').send({ direction: 'in', party_id: id.mumbai, mode: 'upi', amount: 990, tds_amount: 10, paid_on: today }).expect(201);
    expect(await balance('tds_receivable')).toBe(19);
  });
});

describe('day book', () => {
  it('lists the day’s transactions with the money each brought in or took out', async () => {
    const accounts = await w.as('accounts');
    const res = (await accounts.get(`/api/accounting/reports/day-book?from=${today}&to=${today}`).expect(200)).body;
    // In: capital 5,00,000, counter sale 2,360, Bangalore 10,611, Mumbai 990, and two reversals (advance 9,900, deposit 4,500).
    // Out: fabricator 58,500, advance 9,900, rent 36,000, TDS deposit 4,500 twice.
    expect(res.totals).toMatchObject({ money_in: '528361.00', money_out: '113400.00', net: '414961.00' });
    expect(res.totals.entries).toBe(res.data.length);
    const type = (t: string) => res.by_type.find((x: any) => x.type === t);
    expect(type('payment')).toMatchObject({ entries: 6, money_in: '23861.00', money_out: '68400.00' });
    expect(type('expense')).toMatchObject({ entries: 1, amount: '40000.00', money_in: '0.00', money_out: '36000.00' });
    expect(type('tds_deposit')).toMatchObject({ entries: 3, money_in: '4500.00', money_out: '9000.00' });
    expect(type('manual')).toMatchObject({ entries: 1, money_in: '500000.00' });
    expect(type('invoice')).toMatchObject({ entries: 3, money_in: '0.00', money_out: '0.00' });
    // Each line says who it was with, and a reversal is marked as one.
    const rent = res.data.find((e: any) => e.type === 'expense');
    expect(rent.narration).toMatch(/Rent - R K Properties .*TDS 4000\.00/);
    const receipt = res.data.find((e: any) => e.type === 'payment' && e.money_in === '10611.00');
    expect(receipt).toMatchObject({ party_name: 'Bangalore Boards', amount: '10620.00', reversal: false });
    expect(res.data.filter((e: any) => e.reversal).map((e: any) => e.type).sort()).toEqual(['payment', 'tds_deposit']);
    // In the order they were entered.
    expect(res.data.map((e: any) => e.entry_no)).toEqual([...res.data.map((e: any) => e.entry_no)].sort((a, b) => a - b));

    const onlyPayments = (await accounts.get(`/api/accounting/reports/day-book?from=${today}&to=${today}&type=payment`).expect(200)).body;
    expect(onlyPayments.totals).toMatchObject({ entries: 6, money_in: '23861.00', money_out: '68400.00' });
    const yesterday = (await accounts.get(`/api/accounting/reports/day-book?from=${addDays(today, -1)}&to=${addDays(today, -1)}`).expect(200)).body;
    expect(yesterday).toMatchObject({ data: [], totals: { entries: 0, money_in: '0.00', money_out: '0.00', net: '0.00' } });
    await accounts.get(`/api/accounting/reports/day-book?from=${today}&to=${addDays(today, -1)}`).expect(400);
    await (await w.as('sales')).get('/api/accounting/reports/day-book').expect(403);
  });

  it('leaves the books balanced, with the TDS where it belongs', async () => {
    await expectBooksHealthy(w);
    const tb = (await (await w.as('accounts')).get('/api/accounting/reports/trial-balance').expect(200)).body.data;
    expect(tb.find((a: any) => a.name === 'TDS Receivable')).toMatchObject({ debit: '19.00', credit: '0.00' });
    expect(tb.find((a: any) => a.name === 'TDS Payable (Vendors)')).toBeUndefined(); // all paid over
    expect(tb.find((a: any) => a.name === 'Rent')).toMatchObject({ debit: '40000.00' });
  });
});

describe('PAN on a party', () => {
  it('is kept in capitals and checked', async () => {
    const admin = await w.as('admin');
    const landlord = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'R K Properties', pan: 'aaapk1234l' }).expect(201)).body.data;
    expect(landlord.pan).toBe('AAAPK1234L');
    await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Bad PAN Traders', pan: '12345' }).expect(400);
    expect((await admin.patch(`/api/parties/${landlord.id}`).send({ pan: '' }).expect(200)).body.data.pan).toBeNull();
  });
});
