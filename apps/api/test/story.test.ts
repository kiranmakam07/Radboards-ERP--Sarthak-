import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@radcore/shared';
import { config } from '../src/config';
import { expectBooksHealthy, gstin, masters, onHand, setup, type World } from './helpers';

/**
 * One story, start to finish, on an empty company: the owner puts money in, boards are bought,
 * an enquiry becomes a customer, boards are sold, money comes in, the month is closed.
 *
 * After every step it looks at EVERY section the step should have reached (stock, what suppliers
 * are owed, what customers owe, the bank, GST, profit) and checks the figure against one worked
 * out by hand. This is the test that shows the sections are connected: a step in Stores is seen
 * in Accounts, a step in CRM is seen in Sales, and so on.
 *
 * The same run feeds the "How RadCore works" story page: with STORY_OUT set to a file path, what
 * each section showed after each step is written there.
 *
 * The figures:
 *   bought   20 boards at 2,000 + 18% GST          = 40,000 + 7,200
 *   rejected  2 at the quality check, sent back     =  4,000 +   720
 *   sold     15 to a dealer at 3,500 + 18% GST      = 52,500 + 9,450
 *   sold      1 at the counter for 4,130 with GST   =  3,500 +   630
 *   returned  1 by the dealer                       =  3,500 +   630
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const TODAY = istDate();
const trace: { step: string; did: Record<string, unknown>; shows: Snapshot }[] = [];
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
const storeWas = config.fileStore;

type Snapshot = Awaited<ReturnType<typeof look>>;

/** What each section shows right now, read the way the screens read it. */
async function look() {
  const accounts = await w.as('accounts');
  const tb = (await accounts.get('/api/accounting/reports/trial-balance').expect(200)).body;
  const books: Record<string, number> = {};
  for (const a of tb.data) books[a.name] = Number(a.debit) - Number(a.credit);
  const value = (await accounts.get('/api/stock/valuation').expect(200)).body.data.find((r: any) => r.item_id === id.board);
  const owed = (await accounts.get('/api/purchasing/payables').expect(200)).body.data;
  const owes = (await accounts.get('/api/payments/reminders').expect(200)).body.data;
  const gst = (await accounts.get('/api/gst/gstr3b').query({ from: '2026-04-01', to: TODAY }).expect(200)).body.data;
  const pl = (await accounts.get('/api/accounting/reports/profit-and-loss').expect(200)).body;
  return {
    stock: {
      stores: id.board ? await onHand(w.db, id.board, m.stores) : 0,
      showroom: id.board ? await onHand(w.db, id.board, m.showroom) : 0,
      rejected: id.board ? await onHand(w.db, id.board, m.rejected) : 0,
      value: Number(value?.value ?? 0),
    },
    books,
    bank: books['Bank Account'] ?? 0,
    we_owe_suppliers: owed.reduce((s: number, r: any) => s + Number(r.outstanding), 0),
    customers_owe_us: owes.reduce((s: number, r: any) => s + Number(r.total ?? r.outstanding ?? 0), 0),
    gst: { charged: Number(gst.outward.total_tax), claimable: Number(gst.itc.total_tax), to_pay: Number(gst.net_payable.total) },
    profit: { income: Number(pl.total_income), expense: Number(pl.total_expense), net: Number(pl.net_profit) },
    trial_balance_agrees: tb.balanced as boolean,
  };
}

async function record(step: string, did: Record<string, unknown>) {
  const shows = await look();
  trace.push({ step, did, shows });
  return shows;
}

beforeAll(async () => {
  config.fileStore = 'database';
  w = await setup();
  m = await masters(w.db);
});
afterAll(async () => {
  if (process.env.STORY_OUT) fs.writeFileSync(process.env.STORY_OUT, JSON.stringify(trace, null, 1));
  config.fileStore = storeWas;
  await w.close();
});

describe('The story: one month of business, followed through every section', () => {
  it('1. Masters: the item and the supplier are set up once, and every later step reads them', async () => {
    const admin = await w.as('admin');
    id.board = (await admin.post('/api/items').send({
      sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
      retail_price: 4130, dealer_price: 3500, purchase_cost: 2000,
    }).expect(201)).body.data.id;
    id.supplier = (await admin.post('/api/parties').send({
      party_type: 'supplier', name: 'Deck Makers', phone: '9700000001', gstin: gstin('27', 'SUPPL1234A'), payment_terms_days: 30,
    }).expect(201)).body.data.id;
    const s = await record('masters', { item: 'Cruiser Board, GST 18%, dealer price 3,500, counter price 4,130', supplier: 'Deck Makers, Maharashtra' });
    expect(s.stock).toEqual({ stores: 0, showroom: 0, rejected: 0, value: 0 });
  });

  it('2. Accounts: the owner puts 2,00,000 into the bank', async () => {
    const accounts = await w.as('accounts');
    await accounts.post('/api/accounting/journals').send({
      entry_date: TODAY, narration: 'Capital introduced by the owner',
      lines: [{ account_id: m.account('bank'), debit: 200000 }, { account_id: m.account('capital'), credit: 200000 }],
    }).expect(201);
    const s = await record('capital', { amount: 200000 });
    expect(s.bank).toBe(200000);
  });

  it('3. Stores: 20 boards are ordered and counted in, but are not stock until they pass the quality check', async () => {
    const stores = await w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.supplier, lines: [{ item_id: id.board, qty: 20, rate: 2000 }] }).expect(201)).body.data;
    id.po = po.id;
    await stores.post(`/api/purchasing/orders/${id.po}/send`).send({}).expect(200);
    id.poLine = (await stores.get(`/api/purchasing/orders/${id.po}`).expect(200)).body.data.lines[0].id;
    const grn = (await stores.post('/api/purchasing/receipts').send({ purchase_order_id: id.po, lines: [{ po_line_id: id.poLine, received_qty: 20 }] }).expect(201)).body.data;
    id.grn = grn.id;
    const s = await record('received', { po_no: po.po_no, grn_no: grn.grn_no, counted: 20 });
    expect(s.stock.stores).toBe(0);
    expect(s.stock.value).toBe(0);
  });

  it('4. Stores: the quality check passes 18 and rejects 2. Now it is stock, and Accounts sees its value', async () => {
    const stores = await w.as('stores');
    const line = (await stores.get(`/api/purchasing/receipts/${id.grn}`).expect(200)).body.data.lines[0].id;
    await stores.post(`/api/purchasing/receipts/${id.grn}/qc`).send({ lines: [{ grn_line_id: line, accepted_qty: 18, rejected_qty: 2, reject_reason: 'Cracked deck' }] }).expect(200);
    const s = await record('quality_check', { accepted: 18, rejected: 2 });
    expect(s.stock).toEqual({ stores: 18, showroom: 0, rejected: 2, value: 40000 });
    expect(s.books['Stock in Hand']).toBe(40000);
    // Goods are in, the bill is not: the books hold that as "received, not yet billed", and nothing is owed to the supplier yet.
    expect(s.we_owe_suppliers).toBe(0);
  });

  it('5. Accounts: the supplier\'s bill is booked against that order. Now the supplier is owed, and the GST can be claimed', async () => {
    const accounts = await w.as('accounts');
    const bill = (await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.supplier, purchase_order_id: id.po, supplier_invoice_no: 'DM/101', bill_date: TODAY, lines: [{ po_line_id: id.poLine, qty: 20, rate: 2000 }],
    }).expect(201)).body.data;
    id.bill = bill.id;
    expect(bill.grand_total).toBe('47200.00');
    const s = await record('supplier_bill', { bill_no: bill.bill_no, supplier_invoice: 'DM/101', total: 47200 });
    expect(s.we_owe_suppliers).toBe(47200);
    expect(s.gst.claimable).toBe(7200);
    expect(s.stock.value).toBe(40000); // the bill does not touch stock a second time
  });

  it('6. Stores: the 2 rejected boards go back. Stock, what we owe and the GST claim all come down together', async () => {
    const stores = await w.as('stores');
    const back = (await stores.post(`/api/purchasing/receipts/${id.grn}/return`).send({}).expect(201)).body.data;
    const s = await record('supplier_return', { debit_note_no: back.debit_note.bill_no, value: 4720 });
    expect(s.stock).toEqual({ stores: 18, showroom: 0, rejected: 0, value: 36000 });
    expect(s.we_owe_suppliers).toBe(42480);
    expect(s.gst.claimable).toBe(6480);
  });

  it('7. Accounts: the supplier is paid. The bank goes down and nothing is owed', async () => {
    const accounts = await w.as('accounts');
    const pay = (await accounts.post('/api/payments').send({
      direction: 'out', party_id: id.supplier, mode: 'bank_transfer', amount: 42480, reference: 'UTR-DM-1', allocations: [{ purchase_bill_id: id.bill, amount: 42480 }],
    }).expect(201)).body.data;
    const s = await record('supplier_paid', { payment_no: pay.payment_no, amount: 42480 });
    expect(s.bank).toBe(157520);
    expect(s.we_owe_suppliers).toBe(0);
  });

  it('8. CRM: an enquiry comes in from the website. It becomes a lead with an owner and a follow-up, without anyone typing it', async () => {
    const marketing = await w.as('marketing');
    const token = (await marketing.post('/api/masters/campaigns').send({ name: 'Website enquiry form', source_id: m.source('Website') }).expect(201)).body.data.token;
    await request(w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Asha Rao', phone: '9820012345', message: 'Need 15 cruiser boards for my skate school' }).expect(201);
    const sales = await w.as('sales');
    const lead = (await sales.get('/api/leads').expect(200)).body.data[0];
    id.lead = lead.id;
    expect(lead.stage).toBe('new');
    expect(lead.owner_name).toBe('sales user');
    expect(lead.next_follow_up_at).toBeTruthy();
    await record('enquiry', { lead_no: lead.lead_no, source: lead.source_name, owner: lead.owner_name, follow_up_set: Boolean(lead.next_follow_up_at) });
  });

  it('9. CRM: the salesperson replies on WhatsApp with a ready message, sends the price list and sees it opened', async () => {
    const sales = await w.as('sales');
    const hello = (await sales.get('/api/crm/templates').expect(200)).body.data[0];
    const sent = (await sales.post(`/api/crm/leads/${id.lead}/contact`).send({ channel: 'whatsapp', template_id: hello.id }).expect(200)).body.data;
    const file = (await sales.post('/api/files?purpose=share').set('Content-Type', 'application/pdf').set('X-File-Name', 'price-list.pdf').send(PDF).expect(201)).body.data;
    const share = (await sales.post(`/api/leads/${id.lead}/shares`).send({ title: 'Dealer price list', file_url: file.url }).expect(201)).body.data;
    await request(w.app).post(`/api/public/shares/${share.token}/open`).send({}).expect(200);
    const lead = (await sales.get(`/api/leads/${id.lead}`).expect(200)).body.data;
    expect(lead.stage).toBe('contacted');
    const shares = (await sales.get(`/api/leads/${id.lead}/shares`).expect(200)).body.data;
    expect(shares[0].view_count).toBe(1);
    await record('follow_up', { message: sent.text, stage_after: lead.stage, file_opened_times: shares[0].view_count, timeline_entries: lead.activities.length });
  });

  it('10. CRM to Sales: the lead is won. One press makes her a customer; nothing is typed again', async () => {
    const sales = await w.as('sales');
    const won = (await sales.post(`/api/leads/${id.lead}/convert`).send({ party_type: 'dealer', name: "Asha's Skate School" }).expect(200)).body.data;
    id.asha = won.party.id;
    const party = (await sales.get(`/api/parties/${id.asha}`).expect(200)).body.data;
    expect(party.phone).toBe('+919820012345');
    await record('won', { party: party.name, phone_carried_over: party.phone, lead_stage: won.lead.stage });
  });

  it('11. Sales: she orders 15 boards. The price comes from the item master. Nothing moves yet', async () => {
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.asha, lines: [{ item_id: id.board, qty: 15 }] }).expect(201)).body.data;
    id.so = order.id;
    await sales.post(`/api/sales/orders/${id.so}/confirm`).send({}).expect(200);
    const detail = (await sales.get(`/api/sales/orders/${id.so}`).expect(200)).body.data;
    expect(detail.lines[0].rate).toBe('3500.00');
    const s = await record('order', { order_no: order.order_no, rate_from_master: 3500, total: detail.totals?.grand_total ?? null });
    expect(s.stock.stores).toBe(18);
    expect(s.customers_owe_us).toBe(0);
  });

  it('12. Stores: the 15 boards are delivered. Stock drops, and the cost of what was sold reaches the profit report', async () => {
    const stores = await w.as('stores');
    const d = (await stores.post(`/api/sales/orders/${id.so}/deliver`).send({}).expect(201)).body.data;
    const s = await record('delivery', { delivery_no: d.delivery?.delivery_no ?? d.delivery_no ?? null, qty: 15 });
    expect(s.stock).toEqual({ stores: 3, showroom: 0, rejected: 0, value: 6000 });
    expect(s.books['Cost of Goods Sold']).toBe(30000);
    expect(s.customers_owe_us).toBe(0); // delivered, not yet billed
  });

  it('13. Sales: the invoice is raised for what was delivered. Now she owes us, and the GST is due', async () => {
    const sales = await w.as('sales');
    const inv = (await sales.post(`/api/sales/orders/${id.so}/invoice`).send({}).expect(201)).body.data;
    id.inv = inv.id;
    expect(inv.grand_total).toBe('61950.00');
    const s = await record('invoice', { invoice_no: inv.invoice_no, taxable: 52500, gst: 9450, total: 61950 });
    expect(s.customers_owe_us).toBe(61950);
    expect(s.gst.charged).toBe(9450);
    expect(s.profit).toMatchObject({ income: 52500, net: 22500 });
  });

  it('14. Accounts: she pays 30,000. The bank goes up and what she owes comes down', async () => {
    const accounts = await w.as('accounts');
    const pay = (await accounts.post('/api/payments').send({
      direction: 'in', party_id: id.asha, mode: 'upi', amount: 30000, reference: 'UPI-ASHA-1', allocations: [{ invoice_id: id.inv, amount: 30000 }],
    }).expect(201)).body.data;
    const s = await record('receipt', { receipt_no: pay.payment_no, amount: 30000 });
    expect(s.bank).toBe(187520);
    expect(s.customers_owe_us).toBe(31950);
  });

  it('15. Accounts: the bank statement is loaded. All three movements are recognised by themselves', async () => {
    const accounts = await w.as('accounts');
    const [y, mo, d] = TODAY.split('-');
    const on = `${d}/${mo}/${y}`;
    const csv = [
      'Date,Narration,Ref No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      `${on},CAPITAL FROM OWNER,N001,,"2,00,000.00","2,00,000.00"`,
      `${on},NEFT DECK MAKERS UTR-DM-1,N002,"42,480.00",,"1,57,520.00"`,
      `${on},UPI ASHA RAO UPI-ASHA-1,N003,,"30,000.00","1,87,520.00"`,
    ].join('\n');
    const imported = (await accounts.post('/api/bank/statements/import').send({ account_id: m.account('bank'), csv }).expect(201)).body.data;
    const rec = (await accounts.get('/api/bank/reconciliation').query({ account_id: m.account('bank') }).expect(200)).body.data;
    await record('bank_statement', { lines: imported.imported, matched_by_itself: imported.auto_matched, bank_says: Number(rec.summary.statement_balance), books_say: Number(rec.summary.book_balance), left_unmatched: rec.summary.unmatched_statement_lines });
    expect(imported.imported).toBe(3);
    expect(imported.auto_matched).toBe(3);
  });

  it('16. Stores to the shop: 2 boards move to the showroom. The count by place changes; the value does not', async () => {
    const stores = await w.as('stores');
    await stores.post('/api/stock/transfers').send({ from_location_id: m.stores, to_location_id: m.showroom, reason: 'Display stock', lines: [{ item_id: id.board, qty: 2 }] }).expect(201);
    const s = await record('transfer', { qty: 2 });
    expect(s.stock).toEqual({ stores: 1, showroom: 2, rejected: 0, value: 6000 });
  });

  it('17. Store counter: a walk-in buys one board on a quick bill. One save reaches CRM, stock, the invoice list, the bank and GST', async () => {
    const store = await w.as('store');
    const bill = (await store.post('/api/sales/quick-bill').send({
      customer: { phone: '9811100001', name: 'Rohan Mehta' }, lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'upi', amount: 4130, reference: 'UPI-ROHAN' }],
    }).expect(201)).body.data;
    id.walkin = bill.invoice.id;
    const leads = (await (await w.as('marketing')).get('/api/leads').query({ q: 'Rohan' }).expect(200)).body.data;
    const s = await record('quick_bill', { invoice_no: bill.invoice.invoice_no, total: 4130, lead_made: leads[0]?.lead_no ?? null, lead_stage: leads[0]?.stage ?? null, lead_source: leads[0]?.source_name ?? null });
    expect(s.stock).toEqual({ stores: 1, showroom: 1, rejected: 0, value: 4000 });
    expect(s.bank).toBe(191650);
    expect(s.gst.charged).toBe(10080);
    expect(leads[0].stage).toBe('converted');
  });

  it('18. Sales: the dealer returns one board. A credit note puts it back in stock and takes it off what she owes', async () => {
    const accounts = await w.as('accounts');
    const line = (await accounts.get(`/api/sales/invoices/${id.inv}`).expect(200)).body.data.lines[0].id;
    const cn = (await accounts.post(`/api/sales/invoices/${id.inv}/credit-note`).send({ lines: [{ invoice_line_id: line, qty: 1 }], restock: true, reason: 'Wrong size' }).expect(201)).body.data;
    const s = await record('return', { credit_note_no: cn.invoice_no, total: 4130 });
    expect(s.stock.stores + s.stock.showroom).toBe(3);
    expect(s.stock.value).toBe(6000);
    expect(s.customers_owe_us).toBe(27820);
    expect(s.gst.charged).toBe(9450);
  });

  it('19. Accounts: the month\'s rent is paid as an expense', async () => {
    const accounts = await w.as('accounts');
    const e = (await accounts.post('/api/accounting/expenses').send({ category_id: m.expenseCategory('Rent'), amount: 5000, paid_from_account_id: m.account('bank'), vendor_name: 'Landlord' }).expect(201)).body.data;
    const s = await record('expense', { expense_no: e.expense_no, amount: 5000 });
    expect(s.bank).toBe(186650);
  });

  it('20. HR to Accounts: a month of attendance becomes a payslip, the payslip becomes an entry in the books, and paying it leaves the bank', async () => {
    const admin = await w.as('admin');
    const hr = await w.as('hr');
    const accounts = await w.as('accounts');
    id.meera = (await admin.post('/api/hr/employees').send({
      name: 'Meera Joshi', phone: '9833000001', department: 'Stores', designation: 'Stores Assistant', join_date: '2026-06-01', monthly_salary: 15000,
    }).expect(201)).body.data.id;
    let marked = 0;
    for (let day = 1; day <= 30; day++) {
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue; // Sunday is the weekly off and needs no marking
      await hr.put('/api/hr/attendance').send({ date, entries: [{ employee_id: id.meera, status: 'present' }] }).expect(200);
      marked++;
    }
    const run = (await accounts.post('/api/payroll/runs').send({ month: '2026-09' }).expect(201)).body.data;
    const slip = (await accounts.get(`/api/payroll/runs/${run.id}`).expect(200)).body.data.payslips[0];
    await accounts.post(`/api/payroll/runs/${run.id}/approve`).send({}).expect(200);
    const approved = await record('salary_approved', { days_marked: marked, paid_days: slip.paid_days, net_pay: slip.net_pay });
    expect(approved.books['Salaries Payable']).toBe(-15000);
    await accounts.post(`/api/payroll/runs/${run.id}/pay`).send({ paid_from_account_id: m.account('bank') }).expect(200);
    const s = await record('salary_paid', { amount: 15000 });
    expect(s.bank).toBe(171650);
    expect(s.books['Salaries Payable'] ?? 0).toBe(0);
  });

  it('21. Month end: every report is the same data added up, so they agree with each other', async () => {
    const accounts = await w.as('accounts');
    const s = await record('month_end', {});
    // Profit: sold 52,500, cost of those boards 30,000, rent 5,000, salary 15,000.
    expect(s.profit).toEqual({ income: 52500, expense: 50000, net: 2500 });
    // GST: charged 9,450, claimable 6,480.
    expect(s.gst).toEqual({ charged: 9450, claimable: 6480, to_pay: 2970 });
    // What the stock report says the boards are worth is what the balance sheet carries.
    expect(s.stock.value).toBe(6000);
    expect(s.books['Stock in Hand']).toBe(6000);
    const bs = (await accounts.get('/api/accounting/reports/balance-sheet').expect(200)).body;
    expect(Number(bs.total_assets)).toBe(211950); // bank 1,71,650 + she owes 27,820 + stock 6,000 + GST to claim 6,480
    expect(bs.balanced).toBe(true);
    const health = await expectBooksHealthy(w);
    expect(health.stock_matches_gl).toBe(true);
    const dayBook = (await accounts.get('/api/accounting/reports/day-book').query({ from: '2026-09-01', to: TODAY }).expect(200)).body;
    trace.push({ step: 'reports', did: { balance_sheet_total: Number(bs.total_assets), day_book_entries: dayBook.data.length }, shows: s });
  });
});
