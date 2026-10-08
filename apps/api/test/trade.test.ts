import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, onHand, setup, type World } from './helpers';

/**
 * One continuous story, in the order the business runs it:
 * buy stock (PO -> bill -> inward with QC -> supplier return) -> move to showroom ->
 * sell over the counter (quick bill) -> sell to a dealer in another state -> take a return ->
 * collect and pay -> read the books and the GST returns.
 * The expected figures are worked out by hand in the comments.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const TODAY = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

const accountBalance = async (key: string) => {
  const [r] = await rows<{ b: string }>(w.db, sql`
    select coalesce(sum(l.debit) - sum(l.credit), 0)::numeric(14,2)::text as b
      from journal_lines l join accounts a on a.id = l.account_id where a.system_key = ${key}`);
  return Number(r!.b);
};

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  // Board: retail 5900 incl. 18% GST (= 5000 + 900), dealer 4000 + GST, costs 2500.
  const board = await admin.post('/api/items').send({
    sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
    retail_price: 5900, dealer_price: 4000, purchase_cost: 2500, reorder_level: 5, barcode: '8901234567890',
  }).expect(201);
  // Wheels: retail 1120 incl. 12% (= 1000 + 120), dealer 800 + GST, costs 500.
  const wheels = await admin.post('/api/items').send({
    sku: 'WHL-1', name: 'Wheel Set', item_type: 'spare_part', hsn_sac: '950699', gst_rate: 12, retail_price: 1120, dealer_price: 800, purchase_cost: 500,
  }).expect(201);
  const setupSvc = await admin.post('/api/items').send({
    sku: 'SVC-1', name: 'Board Setup', item_type: 'service', hsn_sac: '998729', gst_rate: 18, retail_price: 236,
  }).expect(201);
  id.board = board.body.data.id; id.wheels = wheels.body.data.id; id.svc = setupSvc.body.data.id;

  const accounts = await w.as('accounts');
  const supplier = await accounts.post('/api/parties').send({
    party_type: 'supplier', name: 'Deck Makers', phone: '9700000001', gstin: gstin('27', 'SUPPL1234A'), payment_terms_days: 30,
  }).expect(201);
  const dealer = await accounts.post('/api/parties').send({
    party_type: 'dealer', name: 'Bangalore Boards', phone: '9700000002', gstin: gstin('29', 'DEALR1234B'), credit_limit: 60000, payment_terms_days: 15,
  }).expect(201);
  id.supplier = supplier.body.data.id; id.dealer = dealer.body.data.id;
  expect(dealer.body.data.stateCode).toBe('29'); // read from the GSTIN
});
afterAll(() => w.close());

describe('purchase to stock (QC splits every receipt)', () => {
  it('creates and sends a PO', async () => {
    const stores = await w.as('stores');
    const po = await stores.post('/api/purchasing/orders').send({
      supplier_id: id.supplier, lines: [{ item_id: id.board, qty: 20, rate: 2500 }, { item_id: id.wheels, qty: 50, rate: 500 }],
    }).expect(201);
    id.po = po.body.data.id;
    expect(po.body.data.poNo).toMatch(/^PO\/\d\d-\d\d\/00001$/);
    // Goods cannot be received against a draft PO.
    const detail = await stores.get(`/api/purchasing/orders/${id.po}`).expect(200);
    id.polBoard = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'BRD-1').id;
    id.polWheels = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'WHL-1').id;
    await stores.post('/api/purchasing/receipts').send({ purchase_order_id: id.po, lines: [{ po_line_id: id.polBoard, received_qty: 20 }] }).expect(409);
    await stores.post(`/api/purchasing/orders/${id.po}/send`).send({}).expect(200);
  });

  it('records the supplier bill and posts Dr GRNI + Dr Input GST / Cr Creditors', async () => {
    const accounts = await w.as('accounts');
    // 20 x 2500 = 50,000 @18% = 9,000 ; 50 x 500 = 25,000 @12% = 3,000 ; total 87,000 (intra-state: CGST+SGST)
    const bill = await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.supplier, purchase_order_id: id.po, supplier_invoice_no: 'DM/101', bill_date: TODAY,
      lines: [{ po_line_id: id.polBoard, qty: 20, rate: 2500 }, { po_line_id: id.polWheels, qty: 50, rate: 500 }],
    }).expect(201);
    id.bill = bill.body.data.id;
    expect(bill.body.data.grandTotal).toBe('87000.00');
    expect(bill.body.data.cgstTotal).toBe('6000.00');
    expect(bill.body.data.sgstTotal).toBe('6000.00');
    expect(bill.body.data.igstTotal).toBe('0.00');
    expect(await accountBalance('creditors')).toBe(-87000);
    expect(await accountBalance('grni')).toBe(75000);
    // The same supplier invoice cannot be entered twice.
    await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.supplier, purchase_order_id: id.po, supplier_invoice_no: 'DM/101', bill_date: TODAY, lines: [{ po_line_id: id.polBoard, qty: 1, rate: 2500 }],
    }).expect(409);
  });

  it('goods received are NOT in stock until QC', async () => {
    const stores = await w.as('stores');
    const grn = await stores.post('/api/purchasing/receipts').send({
      purchase_order_id: id.po, lines: [{ po_line_id: id.polBoard, received_qty: 20 }, { po_line_id: id.polWheels, received_qty: 50 }],
    }).expect(201);
    id.grn = grn.body.data.id;
    expect(grn.body.data.status).toBe('received');
    expect(await onHand(w.db, id.board!, m.stores)).toBe(0);
    // Cannot receive more than was ordered.
    await stores.post('/api/purchasing/receipts').send({ purchase_order_id: id.po, lines: [{ po_line_id: id.polBoard, received_qty: 1 }] }).expect(409);
  });

  it('QC: accepted enters Stores at the PO rate, rejected goes to Rejected', async () => {
    const stores = await w.as('stores');
    const detail = await stores.get(`/api/purchasing/receipts/${id.grn}`).expect(200);
    id.grnBoard = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'BRD-1').id;
    id.grnWheels = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'WHL-1').id;
    // accepted + rejected must equal received
    await stores.post(`/api/purchasing/receipts/${id.grn}/qc`).send({
      lines: [{ grn_line_id: id.grnBoard, accepted_qty: 18, rejected_qty: 1, reject_reason: 'x' }, { grn_line_id: id.grnWheels, accepted_qty: 50, rejected_qty: 0 }],
    }).expect(400);
    // a reject needs a reason
    await stores.post(`/api/purchasing/receipts/${id.grn}/qc`).send({
      lines: [{ grn_line_id: id.grnBoard, accepted_qty: 18, rejected_qty: 2 }, { grn_line_id: id.grnWheels, accepted_qty: 50, rejected_qty: 0 }],
    }).expect(400);
    const done = await stores.post(`/api/purchasing/receipts/${id.grn}/qc`).send({
      lines: [
        { grn_line_id: id.grnBoard, accepted_qty: 18, rejected_qty: 2, reject_reason: 'Cracked deck' },
        { grn_line_id: id.grnWheels, accepted_qty: 50, rejected_qty: 0 },
      ],
    }).expect(200);
    expect(done.body.data.status).toBe('inwarded');
    expect(await onHand(w.db, id.board!, m.stores)).toBe(18);
    expect(await onHand(w.db, id.board!, m.rejected)).toBe(2);
    expect(await onHand(w.db, id.wheels!, m.stores)).toBe(50);
    // Stock now holds everything received (20 x 2500 + 50 x 500); GRNI is cleared by the bill.
    expect(await accountBalance('stock')).toBe(75000);
    expect(await accountBalance('grni')).toBe(0);
    // QC cannot be run twice.
    await stores.post(`/api/purchasing/receipts/${id.grn}/qc`).send({
      lines: [{ grn_line_id: id.grnBoard, accepted_qty: 20, rejected_qty: 0 }, { grn_line_id: id.grnWheels, accepted_qty: 50, rejected_qty: 0 }],
    }).expect(409);
    const po = await stores.get(`/api/purchasing/orders/${id.po}`).expect(200);
    expect(po.body.data.status).toBe('received');
  });

  it('rejected stock cannot be sold', async () => {
    const store = await w.as('store');
    const res = await store.post('/api/sales/quick-bill').send({
      location_id: m.rejected, lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'cash', amount: 5900 }],
    }).expect(400);
    expect(res.body.error.message).toMatch(/Rejected/);
  });

  it('one action returns the rejects and raises a debit note against the bill', async () => {
    const stores = await w.as('stores');
    const res = await stores.post(`/api/purchasing/receipts/${id.grn}/return`).send({}).expect(201);
    const dn = res.body.data.debit_note;
    // 2 x 2500 = 5,000 + 18% = 5,900
    expect(dn.docType).toBe('debit_note');
    expect(dn.billNo).toMatch(/^DN\//);
    expect(dn.grandTotal).toBe('5900.00');
    expect(dn.againstBillId).toBe(id.bill);
    expect(await onHand(w.db, id.board!, m.rejected)).toBe(0);
    expect(await accountBalance('stock')).toBe(70000);
    expect(await accountBalance('creditors')).toBe(-81100);
    // Nothing left to return.
    await stores.post(`/api/purchasing/receipts/${id.grn}/return`).send({}).expect(409);
    const accounts = await w.as('accounts');
    const bill = await accounts.get(`/api/purchasing/bills/${id.bill}`).expect(200);
    expect(Number(bill.body.data.outstanding)).toBe(81100);
    await expectBooksHealthy(w);
  });

  it('pays the supplier in part, allocated to the bill', async () => {
    const accounts = await w.as('accounts');
    // Capital first, so the bank has money to pay with.
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Capital introduced',
      lines: [{ account_id: m.account('bank'), debit: 200000 }, { account_id: m.account('capital'), credit: 200000 }],
    }).expect(201);
    await accounts.post('/api/payments').send({
      direction: 'out', party_id: id.supplier, mode: 'bank_transfer', amount: 100000, allocations: [{ purchase_bill_id: id.bill, amount: 100000 }],
    }).expect(409); // more than is outstanding
    const pay = await accounts.post('/api/payments').send({
      direction: 'out', party_id: id.supplier, mode: 'bank_transfer', amount: 50000, reference: 'UTR123',
      allocations: [{ purchase_bill_id: id.bill, amount: 50000 }],
    }).expect(201);
    expect(pay.body.data.paymentNo).toMatch(/^PAY\//);
    const payables = await accounts.get('/api/purchasing/payables').expect(200);
    expect(Number(payables.body.data[0].outstanding)).toBe(31100);
    const bill = await accounts.get(`/api/purchasing/bills/${id.bill}`).expect(200);
    expect(bill.body.data.payment_status).toBe('partly_paid');
  });
});

describe('inventory', () => {
  it('transfers Stores -> Showroom without changing stock value', async () => {
    const stores = await w.as('stores');
    await stores.post('/api/stock/transfers').send({
      from_location_id: m.stores, to_location_id: m.showroom, reason: 'Display stock',
      lines: [{ item_id: id.board, qty: 10 }, { item_id: id.wheels, qty: 20 }],
    }).expect(201);
    expect(await onHand(w.db, id.board!, m.showroom)).toBe(10);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(8);
    expect(await accountBalance('stock')).toBe(70000);
    // You cannot transfer what is not there.
    await stores.post('/api/stock/transfers').send({
      from_location_id: m.stores, to_location_id: m.showroom, reason: 'Too many', lines: [{ item_id: id.board, qty: 9 }],
    }).expect(409);
  });

  it('adjustments do nothing until an admin approves', async () => {
    const stores = await w.as('stores');
    const adj = await stores.post('/api/stock/adjustments').send({
      location_id: m.stores, reason: 'Damaged in handling', lines: [{ item_id: id.wheels, qty_change: -2 }],
    }).expect(201);
    expect(adj.body.data.status).toBe('pending');
    expect(await onHand(w.db, id.wheels!, m.stores)).toBe(30);
    await stores.post(`/api/stock/adjustments/${adj.body.data.id}/approve`).send({}).expect(403); // stores cannot approve their own
    const owner = await w.as('owner');
    await owner.post(`/api/stock/adjustments/${adj.body.data.id}/approve`).send({}).expect(200);
    expect(await onHand(w.db, id.wheels!, m.stores)).toBe(28);
    expect(await accountBalance('stock')).toBe(69000); // 2 x 500 written off
    expect(await accountBalance('stock_adjustment')).toBe(1000);
    await owner.post(`/api/stock/adjustments/${adj.body.data.id}/approve`).send({}).expect(409);
  });

  it('a physical count works out the difference itself', async () => {
    const stores = await w.as('stores');
    const count = await stores.post('/api/stock/counts').send({
      location_id: m.stores, reason: 'Monthly count', lines: [{ item_id: id.wheels, counted_qty: 30 }, { item_id: id.board, counted_qty: 8 }],
    }).expect(201);
    const detail = await stores.get(`/api/stock/adjustments/${count.body.data.id}`).expect(200);
    const wheels = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'WHL-1');
    expect(Number(wheels.system_qty)).toBe(28);
    expect(Number(wheels.qty_change)).toBe(2);
    const admin = await w.as('admin');
    await admin.post(`/api/stock/adjustments/${count.body.data.id}/approve`).send({}).expect(200);
    expect(await onHand(w.db, id.wheels!, m.stores)).toBe(30);
    expect(await accountBalance('stock')).toBe(70000);
    await expectBooksHealthy(w);
  });

  it('shows low stock against the reorder level', async () => {
    const admin = await w.as('admin');
    await admin.patch(`/api/items/${id.board}`).send({ reorder_level: 25 }).expect(200);
    const low = await admin.get('/api/stock/low').expect(200);
    expect(low.body.data.map((r: { sku: string }) => r.sku)).toContain('BRD-1');
    await admin.patch(`/api/items/${id.board}`).send({ reorder_level: 5 }).expect(200);
  });
});

describe('store quick bill (one transaction)', () => {
  it('previews price and tax from the retail (tax-inclusive) price list', async () => {
    const store = await w.as('store');
    const res = await store.post('/api/sales/price-preview').send({ lines: [{ item_id: id.board, qty: 1 }, { item_id: id.wheels, qty: 2 }] }).expect(200);
    expect(res.body.data.tax_inclusive).toBe(true);
    expect(res.body.data.totals.grand_total).toBe('8140.00'); // 5900 + 2 x 1120
    expect(res.body.data.totals.taxable_total).toBe('7000.00');
  });

  it('bills a walk-in: lead + party + order + invoice + stock + payment + journal, nothing retyped', async () => {
    const store = await w.as('store');
    const res = await store.post('/api/sales/quick-bill').send({
      customer: { phone: '9811100001', name: 'Rahul Walkin' },
      lines: [{ item_id: id.board, qty: 1 }, { item_id: id.wheels, qty: 2 }, { item_id: id.svc, qty: 1 }],
      payments: [{ mode: 'upi', amount: 5000, reference: 'UPI-1' }, { mode: 'cash', amount: 3376 }],
    }).expect(201);
    const inv = res.body.data.invoice;
    id.inv1 = inv.id;
    // 5900 + 2240 + 236 = 8376 ; taxable 5000 + 2000 + 200 = 7200 ; CGST = SGST = 450 + 120 + 18 = 588
    expect(inv.invoiceNo).toMatch(/^INV\/\d\d-\d\d\/00001$/);
    expect(inv.invoiceNo.length).toBeLessThanOrEqual(16);
    expect(inv.status).toBe('issued');
    expect(inv.grandTotal).toBe('8376.00');
    expect(inv.taxableTotal).toBe('7200.00');
    expect(inv.cgstTotal).toBe('588.00');
    expect(inv.sgstTotal).toBe('588.00');
    expect(inv.igstTotal).toBe('0.00');
    expect(res.body.data.balance_due).toBe('0.00');
    expect(res.body.data.payments).toHaveLength(2);

    // stock left the Showroom
    expect(await onHand(w.db, id.board!, m.showroom)).toBe(9);
    expect(await onHand(w.db, id.wheels!, m.showroom)).toBe(18);

    // the walk-in was recorded as a lead and converted, and the order is attributed to it
    const [lead] = await rows<{ stage: string; party_id: string; source: string }>(w.db, sql`
      select l.stage, l.party_id, s.name as source from leads l join lead_sources s on s.id = l.source_id where l.phone = '+919811100001'`);
    expect(lead!.stage).toBe('converted');
    expect(lead!.source).toBe('Walk-in');
    const [order] = await rows<{ channel: string; status: string; lead_id: string }>(w.db, sql`select channel, status, lead_id from sales_orders where id = ${res.body.data.order_id}`);
    expect(order).toMatchObject({ channel: 'store', status: 'invoiced' });
    expect(order!.lead_id).toBeTruthy();

    const doc = await store.get(`/api/sales/invoices/${inv.id}`).expect(200);
    expect(doc.body.data.payment.payment_status).toBe('paid');
    expect(doc.body.data.amount_in_words).toBe('Rupees Eight Thousand Three Hundred Seventy Six Only');
    expect(doc.body.data.lines).toHaveLength(3);
    expect(doc.body.data.hsn_summary.length).toBeGreaterThan(0);
    expect(doc.body.data.is_inter_state).toBe(false);

    // COGS at moving-average cost: 1 x 2500 + 2 x 500
    expect(await accountBalance('cogs')).toBe(3500);
    expect(await accountBalance('sales')).toBe(-7200);
    expect(await accountBalance('debtors')).toBe(0);
    await expectBooksHealthy(w);
  });

  it('a failed bill leaves NO trace and does not burn an invoice number', async () => {
    const store = await w.as('store');
    const before = await rows<{ n: number }>(w.db, sql`select (select count(*) from sales_orders)::int + (select count(*) from invoices)::int + (select count(*) from payments)::int + (select count(*) from stock_movements)::int + (select count(*) from journal_entries)::int as n`);
    const res = await store.post('/api/sales/quick-bill').send({
      customer: { phone: '9811100002', name: 'No Stock' }, lines: [{ item_id: id.board, qty: 99 }], payments: [{ mode: 'cash', amount: 100 }],
    }).expect(409);
    expect(res.body.error.message).toMatch(/Not enough stock of Cruiser Board/);
    const after = await rows<{ n: number }>(w.db, sql`select (select count(*) from sales_orders)::int + (select count(*) from invoices)::int + (select count(*) from payments)::int + (select count(*) from stock_movements)::int + (select count(*) from journal_entries)::int as n`);
    expect(after[0]!.n).toBe(before[0]!.n);
    const [lead] = await rows(w.db, sql`select 1 from leads where phone = '+919811100002'`);
    expect(lead).toBeUndefined();

    // The next real bill gets the very next number: the series has no gap.
    const ok = await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 1 }], payments: [{ mode: 'cash', amount: 1120 }] }).expect(201);
    expect(ok.body.data.invoice.invoiceNo).toMatch(/00002$/);
    expect(ok.body.data.invoice.partyName).toBe('Cash Sale');
    id.inv2 = ok.body.data.invoice.id;
  });

  it('will not sell on credit to nobody, or take more than the bill', async () => {
    const store = await w.as('store');
    await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 1 }], payments: [{ mode: 'cash', amount: 500 }] }).expect(400);
    await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 1 }], payments: [{ mode: 'cash', amount: 2000 }] }).expect(400);
    await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 0 }], payments: [] }).expect(400);
  });

  it('finds a repeat customer by phone and bills the same party again, part on credit', async () => {
    const store = await w.as('store');
    const lookup = await store.get('/api/leads/lookup').query({ phone: '9811100001' }).expect(200);
    expect(lookup.body.data.parties).toHaveLength(1);
    expect(lookup.body.data.purchases).toHaveLength(1);
    id.rahul = lookup.body.data.parties[0].id;
    const res = await store.post('/api/sales/quick-bill').send({
      party_id: id.rahul, lines: [{ item_id: id.wheels, qty: 1, discount: 120 }], payments: [{ mode: 'card', amount: 600 }],
    }).expect(201);
    id.inv3 = res.body.data.invoice.id;
    expect(res.body.data.invoice.grandTotal).toBe('1000.00'); // 1120 - 120 discount
    expect(res.body.data.balance_due).toBe('400.00');
    const doc = await store.get(`/api/sales/invoices/${id.inv3}`).expect(200);
    expect(doc.body.data.payment.payment_status).toBe('partly_paid');
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from parties where phone = '+919811100001'`);
    expect(n!.n).toBe(1);
  });

  it('issued invoices are immutable, even with direct database access', async () => {
    await expect(w.db.execute(sql`update invoices set grand_total = 1 where id = ${id.inv1}`)).rejects.toThrow();
    await expect(w.db.execute(sql`update invoice_lines set qty = 99 where invoice_id = ${id.inv1}`)).rejects.toThrow();
    await expect(w.db.execute(sql`delete from invoices where id = ${id.inv1}`)).rejects.toThrow();
    await expect(w.db.execute(sql`delete from stock_movements`)).rejects.toThrow();
    await expect(w.db.execute(sql`update journal_lines set debit = debit + 1`)).rejects.toThrow();
  });
});

describe('dealer flow: quote -> order -> partial delivery -> invoice (inter-state)', () => {
  it('quotes at the dealer price list, tax-exclusive, with IGST for another state', async () => {
    const sales = await w.as('sales');
    const res = await sales.post('/api/sales/orders').send({
      channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 6 }, { item_id: id.wheels, qty: 10, discount: 500 }],
    }).expect(201);
    id.so = res.body.data.id;
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.placeOfSupply).toBe('29');
    const detail = await sales.get(`/api/sales/orders/${id.so}`).expect(200);
    // 6 x 4000 = 24,000 @18% = 4,320 ; 10 x 800 - 500 = 7,500 @12% = 900 ; total 36,720
    expect(detail.body.data.totals).toMatchObject({ taxable_total: '31500.00', igst_total: '5220.00', cgst_total: '0.00', grand_total: '36720.00' });
    id.solBoard = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'BRD-1').id;
    id.solWheels = detail.body.data.lines.find((l: { sku: string }) => l.sku === 'WHL-1').id;
    // A quote cannot be delivered or invoiced.
    await sales.post(`/api/sales/orders/${id.so}/deliver`).send({}).expect(409);
  });

  it('holds the order at the credit limit unless Accounts or the owner overrides', async () => {
    const sales = await w.as('sales');
    const admin = await w.as('admin');
    await admin.patch(`/api/parties/${id.dealer}`).send({ credit_limit: 30000 }).expect(200);
    const blocked = await sales.post(`/api/sales/orders/${id.so}/confirm`).send({}).expect(409);
    expect(blocked.body.error.message).toMatch(/credit limit/);
    await sales.post(`/api/sales/orders/${id.so}/confirm`).send({ override_credit: true }).expect(403);
    const accounts = await w.as('accounts');
    const ok = await accounts.post(`/api/sales/orders/${id.so}/confirm`).send({ override_credit: true }).expect(200);
    expect(ok.body.data.status).toBe('confirmed');
    await admin.patch(`/api/parties/${id.dealer}`).send({ credit_limit: 60000 }).expect(200);
  });

  it('delivers in two parts from Stores and invoices each delivery', async () => {
    const sales = await w.as('sales');
    const d1 = await sales.post(`/api/sales/orders/${id.so}/deliver`).send({
      lines: [{ order_line_id: id.solBoard, qty: 4 }, { order_line_id: id.solWheels, qty: 10 }],
    }).expect(201);
    expect(d1.body.data.order.status).toBe('confirmed'); // boards still pending
    expect(await onHand(w.db, id.board!, m.stores)).toBe(4);
    await sales.post(`/api/sales/orders/${id.so}/deliver`).send({ lines: [{ order_line_id: id.solBoard, qty: 3 }] }).expect(409); // only 2 pending

    const i1 = await sales.post(`/api/sales/orders/${id.so}/invoice`).send({}).expect(201);
    id.dealerInv1 = i1.body.data.id;
    // 4 x 4000 = 16,000 @18% = 2,880 ; wheels 7,500 @12% = 900 ; total 27,280
    expect(i1.body.data).toMatchObject({ taxableTotal: '23500.00', igstTotal: '3780.00', cgstTotal: '0.00', grandTotal: '27280.00', partyGstin: gstin('29', 'DEALR1234B') });
    await sales.post(`/api/sales/orders/${id.so}/invoice`).send({}).expect(409); // nothing more delivered yet

    const d2 = await sales.post(`/api/sales/orders/${id.so}/deliver`).send({}).expect(201); // the rest
    expect(d2.body.data.order.status).toBe('delivered');
    const i2 = await sales.post(`/api/sales/orders/${id.so}/invoice`).send({}).expect(201);
    id.dealerInv2 = i2.body.data.id;
    expect(i2.body.data.grandTotal).toBe('9440.00'); // 2 x 4000 + 18%
    const order = await sales.get(`/api/sales/orders/${id.so}`).expect(200);
    expect(order.body.data.status).toBe('invoiced');
    expect(order.body.data.invoices).toHaveLength(2);
    // Delivered orders cannot be cancelled.
    await sales.post(`/api/sales/orders/${id.so}/cancel`).send({ reason: 'changed mind' }).expect(409);
    await expectBooksHealthy(w);
  });

  it('one receipt settles several invoices; the rest stays as an advance', async () => {
    const accounts = await w.as('accounts');
    const pay = await accounts.post('/api/payments').send({
      direction: 'in', party_id: id.dealer, mode: 'bank_transfer', amount: 40000, reference: 'NEFT-9',
      allocations: [{ invoice_id: id.dealerInv1, amount: 27280 }, { invoice_id: id.dealerInv2, amount: 5000 }],
    }).expect(201);
    id.dealerPay = pay.body.data.id;
    const list = await accounts.get('/api/payments').query({ party_id: id.dealer }).expect(200);
    expect(Number(list.body.data[0].unallocated)).toBe(7720);
    // Use part of the advance later.
    await accounts.post(`/api/payments/${id.dealerPay}/allocate`).send({ allocations: [{ invoice_id: id.dealerInv2, amount: 9999 }] }).expect(409);
    await accounts.post(`/api/payments/${id.dealerPay}/allocate`).send({ allocations: [{ invoice_id: id.dealerInv2, amount: 4440 }] }).expect(200);
    const inv = await accounts.get(`/api/sales/invoices/${id.dealerInv2}`).expect(200);
    expect(inv.body.data.payment.payment_status).toBe('paid');
    const party = await accounts.get(`/api/parties/${id.dealer}`).expect(200);
    expect(Number(party.body.data.balance)).toBe(-3280); // 36,720 billed - 40,000 received: we hold 3,280 advance
    // A receipt cannot be pointed at someone else's invoice.
    await accounts.post('/api/payments').send({
      direction: 'in', party_id: id.dealer, mode: 'cash', amount: 100, allocations: [{ invoice_id: id.inv3, amount: 100 }],
    }).expect(400);
  });
});

describe('returns and corrections', () => {
  it('a credit note returns goods to stock and reverses tax pro-rata', async () => {
    const accounts = await w.as('accounts');
    const doc = await accounts.get(`/api/sales/invoices/${id.dealerInv1}`).expect(200);
    const boardLine = doc.body.data.lines.find((l: { description: string }) => l.description === 'Cruiser Board');
    const before = await onHand(w.db, id.board!, m.showroom);
    const cn = await accounts.post(`/api/sales/invoices/${id.dealerInv1}/credit-note`).send({
      lines: [{ invoice_line_id: boardLine.id, qty: 1 }], restock: true, reason: 'Transit damage',
    }).expect(201);
    id.cn = cn.body.data.id;
    expect(cn.body.data.invoiceNo).toMatch(/^CN\/\d\d-\d\d\/00001$/);
    expect(cn.body.data).toMatchObject({ docType: 'credit_note', taxableTotal: '4000.00', igstTotal: '720.00', grandTotal: '4720.00' });
    expect(await onHand(w.db, id.board!, m.showroom)).toBe(before + 1);
    // Cannot return more than was sold.
    await accounts.post(`/api/sales/invoices/${id.dealerInv1}/credit-note`).send({
      lines: [{ invoice_line_id: boardLine.id, qty: 4 }], restock: true, reason: 'too many',
    }).expect(409);
    const party = await accounts.get(`/api/parties/${id.dealer}`).expect(200);
    expect(Number(party.body.data.balance)).toBe(-8000);
    await expectBooksHealthy(w);
  });

  it('cancelling a counter sale voids invoice, receipt and stock together, keeping the number', async () => {
    const accounts = await w.as('accounts');
    const wheelsBefore = await onHand(w.db, id.wheels!, m.showroom);
    // Payments are attached: must be told to cancel them too.
    await accounts.post(`/api/sales/invoices/${id.inv2}/cancel`).send({ reason: 'Wrong item billed' }).expect(409);
    const res = await accounts.post(`/api/sales/invoices/${id.inv2}/cancel`).send({ reason: 'Wrong item billed', restock: true, cancel_payments: true }).expect(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(res.body.data.invoiceNo).toMatch(/00002$/);
    expect(await onHand(w.db, id.wheels!, m.showroom)).toBe(wheelsBefore + 1);
    await accounts.post(`/api/sales/invoices/${id.inv2}/cancel`).send({ reason: 'again' }).expect(409);
    // store staff cannot cancel invoices
    const store = await w.as('store');
    await store.post(`/api/sales/invoices/${id.inv1}/cancel`).send({ reason: 'x' }).expect(403);
    await expectBooksHealthy(w);
  });

  it('an invoice with a credit note cannot be cancelled', async () => {
    const accounts = await w.as('accounts');
    await accounts.post(`/api/sales/invoices/${id.dealerInv1}/cancel`).send({ reason: 'x', cancel_payments: true }).expect(409);
  });
});

describe('accounts', () => {
  it('books an expense with input GST', async () => {
    const accounts = await w.as('accounts');
    await accounts.post('/api/accounting/expenses').send({
      category_id: m.expenseCategory('Rent'), amount: 20000, gst_type: 'intra', gst_amount: 3600, paid_from_account_id: m.account('bank'),
    }).expect(400); // input GST needs the vendor GSTIN
    const res = await accounts.post('/api/accounting/expenses').send({
      category_id: m.expenseCategory('Rent'), amount: 20000, gst_type: 'intra', gst_amount: 3600, paid_from_account_id: m.account('bank'),
      vendor_name: 'Landlord', vendor_gstin: gstin('27', 'LANDL1234C'),
    }).expect(201);
    expect(res.body.data).toMatchObject({ cgst: '1800.00', sgst: '1800.00', igst: '0.00' });
    // Expenses can only be paid from a cash/bank account.
    await accounts.post('/api/accounting/expenses').send({ category_id: m.expenseCategory('Rent'), amount: 10, paid_from_account_id: m.account('sales') }).expect(409);
  });

  it('refuses an unbalanced manual journal', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Bad', lines: [{ account_id: m.account('bank'), debit: 100 }, { account_id: m.account('capital'), credit: 90 }],
    }).expect(400);
    expect(res.body.error.message).toMatch(/must be equal/);
    // Debtors needs a party; Stock is ledger-driven.
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'No party', lines: [{ account_id: m.account('debtors'), debit: 100 }, { account_id: m.account('capital'), credit: 100 }],
    }).expect(400);
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Stock fiddle', lines: [{ account_id: m.account('stock'), debit: 100 }, { account_id: m.account('capital'), credit: 100 }],
    }).expect(400);
  });

  it('produces a balanced trial balance, P&L and balance sheet from the journal', async () => {
    const accounts = await w.as('accounts');
    const health = await expectBooksHealthy(w);
    expect(health.stock_matches_gl).toBe(true);
    const pl = await accounts.get('/api/accounting/reports/profit-and-loss').expect(200);
    // Sales: 7,200 + 892.86 (inv3: 1000 incl. 12%) + 31,500 dealer - 4,000 credit note. inv2 was cancelled.
    expect(Number(pl.body.total_income)).toBeCloseTo(7200 + 892.86 + 31500 - 4000, 2);
    // Expenses: COGS 21,500 (3,500 + 500 + 20,000 - 2,500 returned) + rent 20,000; the write-off and the count gain cancel out.
    expect(Number(pl.body.total_expense)).toBe(41500);
    expect(Number(pl.body.net_profit)).toBeCloseTo(Number(pl.body.total_income) - 41500, 2);
    const bs = await accounts.get('/api/accounting/reports/balance-sheet').expect(200);
    expect(bs.body.balanced).toBe(true);
    const tb = await accounts.get('/api/accounting/reports/trial-balance?format=csv').expect(200);
    expect(tb.text).toContain('Stock in Hand');
  });

  it('party ledger and ageing come straight from the same records', async () => {
    const accounts = await w.as('accounts');
    const ledger = await accounts.get(`/api/parties/${id.rahul}/ledger`).expect(200);
    expect(Number(ledger.body.closing_balance)).toBe(400);
    expect(ledger.body.data.at(-1).balance).toBe('400.00');
    const ageing = await accounts.get('/api/accounting/reports/receivables-ageing').expect(200);
    const rahul = ageing.body.data.find((r: { party_name: string }) => r.party_name === 'Rahul Walkin');
    expect(Number(rahul.total)).toBe(400);
    const bank = await accounts.get('/api/accounting/reports/ledger').query({ account_id: m.account('bank') }).expect(200);
    expect(Number(bank.body.closing_balance)).toBe(200000 - 50000 + 5000 + 600 + 40000 - 23600);
  });

  it('a locked period blocks every kind of posting', async () => {
    const accounts = await w.as('accounts');
    const store = await w.as('store');
    await store.put('/api/settings/period-lock').send({ period_lock_date: TODAY }).expect(403);
    await accounts.put('/api/settings/period-lock').send({ period_lock_date: TODAY }).expect(200);
    const bill = await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 1 }], payments: [{ mode: 'cash', amount: 1120 }] }).expect(409);
    expect(bill.body.error.code).toBe('period_locked');
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Late entry', lines: [{ account_id: m.account('bank'), debit: 1 }, { account_id: m.account('capital'), credit: 1 }],
    }).expect(409);
    // Even a direct insert is stopped by the database.
    await expect(w.db.execute(sql`insert into journal_entries (entry_date, ref_type) values (${TODAY}::date, 'hack')`)).rejects.toThrow();
    await accounts.put('/api/settings/period-lock').send({ period_lock_date: null }).expect(200);
    await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.wheels, qty: 1 }], payments: [{ mode: 'cash', amount: 1120 }] }).expect(201);
  });

  it('writes an audit trail with before/after values', async () => {
    const admin = await w.as('admin');
    const log = await admin.get('/api/settings/audit-log').query({ entity: 'invoice', entity_id: id.inv2 }).expect(200);
    expect(log.body.data.map((a: { action: string }) => a.action).sort()).toEqual(['cancel', 'issue']);
    expect(log.body.data.find((a: { action: string }) => a.action === 'cancel').user_name).toBe('accounts user');
    await expect(w.db.execute(sql`delete from audit_log`)).rejects.toThrow();
  });
});

describe('GST returns', () => {
  it('GSTR-1 splits B2B and B2C, nets credit notes and lists documents issued', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.get('/api/gst/gstr1').expect(200);
    const g = res.body.data;
    // B2B: the two dealer invoices (inter-state, IGST)
    expect(new Set(g.b2b.map((r: { invoice_no: string }) => r.invoice_no)).size).toBe(2);
    expect(g.b2b.every((r: { place_of_supply: string; cgst: string }) => r.place_of_supply === '29' && Number(r.cgst) === 0)).toBe(true);
    expect(g.b2b.reduce((s: number, r: { taxable_value: string }) => s + Number(r.taxable_value), 0)).toBe(31500);
    // The dealer's credit note is in CDNR
    expect(g.cdnr).toHaveLength(1);
    expect(Number(g.cdnr[0].igst)).toBe(720);
    // B2C small: counter sales in Maharashtra by rate (cancelled invoice excluded)
    const b2c18 = g.b2cs.find((r: { rate: string }) => Number(r.rate) === 18);
    expect(Number(b2c18.taxable_value)).toBe(5200); // board 5000 + setup 200
    expect(Number(b2c18.cgst)).toBe(468);
    // Documents issued: 6 invoice numbers used, 1 cancelled, no gaps
    const docs = g.docs.find((d: { document: string }) => d.document.startsWith('Invoices'));
    expect(docs).toMatchObject({ total: 6, cancelled: 1, net_issued: 5 });
    expect(docs.from_no).toMatch(/00001$/);
    expect(docs.to_no).toMatch(/00006$/);
    const hsnCsv = await accounts.get('/api/gst/gstr1?section=hsn&format=csv').expect(200);
    expect(hsnCsv.text).toContain('950699');
  });

  it('GSTR-3B ties to the GST ledgers', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.get('/api/gst/gstr3b').expect(200);
    const g = res.body.data;
    const outputGl = -((await accountBalance('output_cgst')) + (await accountBalance('output_sgst')) + (await accountBalance('output_igst')));
    const inputGl = (await accountBalance('input_cgst')) + (await accountBalance('input_sgst')) + (await accountBalance('input_igst'));
    expect(Number(g.outward.total_tax)).toBeCloseTo(outputGl, 2);
    expect(Number(g.itc.total_tax)).toBeCloseTo(inputGl, 2);
    // ITC: bill 12,000 - debit note 900 + rent 3,600
    expect(Number(g.itc.total_tax)).toBe(14700);
    expect(Number(g.net_payable.total)).toBeCloseTo(outputGl - inputGl, 2);
    const store = await w.as('store');
    await store.get('/api/gst/gstr3b').expect(403);
  });
});

describe('dashboards', () => {
  it('sales, marketing and accounts dashboards compute live from the records', async () => {
    const owner = await w.as('owner');
    const sales = await owner.get('/api/dashboards/sales').expect(200);
    const channels = Object.fromEntries(sales.body.data.sales_today.map((c: { channel: string; value: string }) => [c.channel, Number(c.value)]));
    expect(channels.dealer).toBe(36720 - 4720);
    expect(channels.store).toBe(8376 + 1000 + 1120);
    expect(sales.body.data.walk_ins_today.purchases).toBe(1);
    expect(sales.body.data.top_items[0].item).toBe('Cruiser Board');
    expect(sales.body.data.dealer_outstanding[0].name).toBe('Bangalore Boards');

    const marketing = await owner.get('/api/dashboards/marketing').expect(200);
    const walkIn = marketing.body.data.by_source.find((s: { source: string }) => s.source === 'Walk-in');
    expect(walkIn.converted).toBe(1);
    expect(Number(walkIn.revenue)).toBe(8376 + 1000); // both of Rahul's invoices, attributed through the lead

    const acc = await owner.get('/api/dashboards/accounts').expect(200);
    expect(Number(acc.body.data.receivables.total)).toBe(400);
    expect(Number(acc.body.data.payables.total)).toBe(31100);
    expect(acc.body.data.cash_and_bank).toHaveLength(2);
    expect(Number(acc.body.data.gst_this_month.itc.total_tax)).toBe(14700);
  });
});
