import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { reminderText } from '../src/modules/collect';
import { expectBooksHealthy, masters, openingStock, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const today = istDate();

/** Sell `qty` boards to a party on credit, invoiced on the given day. Returns the invoice. */
const sellOnCredit = async (partyId: string, qty: number, invoiceDate: string) => {
  const sales = await w.as('sales');
  const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: partyId, order_date: invoiceDate, lines: [{ item_id: id.board, qty }] }).expect(201)).body.data;
  await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
  await (await w.as('stores')).post(`/api/sales/orders/${order.id}/deliver`).send({ location_id: m.stores }).expect(201);
  return (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({ invoice_date: invoiceDate }).expect(201)).body.data;
};

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  // Bought at 500, sold to dealers at 1,000 before GST.
  id.board = (await admin.post('/api/items').send({ sku: 'BRD-1', name: 'Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 1180, dealer_price: 1000, purchase_cost: 500 }).expect(201)).body.data.id;
  await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '100', unit_cost: '500.00' }]);
  const party = async (name: string, phone: string | null, terms: number) =>
    (await admin.post('/api/parties').send({ party_type: 'dealer', name, phone: phone ?? '', payment_terms_days: terms }).expect(201)).body.data.id as string;
  id.late = await party('Mumbai Skate Co', '9820077777', 7);
  id.notDue = await party('Pune Boards', '9820088888', 30);
  id.noPhone = await party('Nashik Wheels', null, 0);
});
afterAll(async () => {
  await w.close();
});

describe('who owes what, and reminding them', () => {
  it('lists each customer with what is pending and what is past its due date, the most overdue first', async () => {
    id.inv1 = (await sellOnCredit(id.late!, 10, addDays(today, -20))).id; // due 13 days ago
    id.inv2 = (await sellOnCredit(id.late!, 2, addDays(today, -3))).id; // due in 4 days
    await sellOnCredit(id.notDue!, 5, addDays(today, -10)); // due in 20 days
    await sellOnCredit(id.noPhone!, 1, addDays(today, -1));
    // Part of the old invoice is paid: 11,800 billed, 5,000 received.
    await (await w.as('accounts')).post('/api/payments').send({ direction: 'in', party_id: id.late, mode: 'upi', amount: 5000, allocations: [{ invoice_id: id.inv1, amount: 5000 }] }).expect(201);
    // A counter sale paid in full owes nothing and is not on the list.
    await (await w.as('store')).post('/api/sales/quick-bill').send({ location_id: m.stores, lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'cash', amount: 1180 }] }).expect(201);

    const list = (await (await w.as('accounts')).get('/api/payments/reminders').expect(200)).body.data;
    expect(list.map((p: any) => p.party_name)).toEqual(['Mumbai Skate Co', 'Nashik Wheels', 'Pune Boards']); // by what is overdue
    expect(list[0]).toMatchObject({ total: '9160.00', overdue: '6800.00', phone: '+919820077777', last_reminded_at: null, reminders_sent: 0 });
    expect(list[0].invoices.map((i: any) => [i.outstanding, i.days_overdue])).toEqual([['6800.00', 13], ['2360.00', 0]]);
    expect(list[1]).toMatchObject({ total: '1180.00', overdue: '1180.00', phone: null });
    expect(list[2]).toMatchObject({ total: '5900.00', overdue: '0.00' });
  });

  it('writes the reminder with the exact amounts and a link to each bill, and notes that it was sent', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.post(`/api/payments/reminders/${id.late}`).send({}).expect(201);
    const { text, whatsapp_url: url, total } = res.body.data;
    expect(total).toBe('9160.00');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Dear Mumbai Skate Co,');
    expect(lines[1]).toBe('A gentle reminder from Radboards Pvt Ltd: ₹9,160.00 is pending.');
    expect(lines[2]).toMatch(/^INV\/\d\d-\d\d\/\d+ of \d\d-\d\d-\d{4}: ₹6,800\.00 \(was due \d\d-\d\d-\d{4}\)$/);
    expect(lines[3]).toMatch(/^http:\/\/localhost:3000\/i\/[\w-]{20,}$/);
    expect(lines[4]).toMatch(/: ₹2,360\.00$/); // not due yet, so no "was due"
    expect(lines.at(-1)).toBe('Please ignore this if you have already paid. Thank you.');
    expect(url.startsWith('https://wa.me/919820077777?text=Dear%20Mumbai')).toBe(true);

    const after = (await accounts.get('/api/payments/reminders').expect(200)).body.data[0];
    expect(after.reminders_sent).toBe(1);
    expect(after.last_reminded_at).toBeTruthy();
    // The link to a bill stays the same every time it is sent.
    const again = (await accounts.post(`/api/payments/reminders/${id.late}`).send({}).expect(201)).body.data.text.split('\n');
    expect(again[3]).toBe(lines[3]);

    expect((await accounts.post(`/api/payments/reminders/${id.noPhone}`).send({}).expect(400)).body.error.message).toMatch(/has no phone number/);
    const paidUp = (await accounts.post('/api/parties').send({ party_type: 'customer', name: 'All Square', phone: '9820099999' }).expect(201)).body.data.id;
    expect((await accounts.post(`/api/payments/reminders/${paidUp}`).send({}).expect(400)).body.error.message).toBe('All Square does not owe anything');
    await (await w.as('hr')).get('/api/payments/reminders').expect(403);
    await (await w.as('owner')).post(`/api/payments/reminders/${id.late}`).send({}).expect(403); // the owner looks, accounts sends
  });

  it('mentions how to pay and stops listing after five bills', () => {
    const due = (n: number) => ({ id: String(n), invoice_no: `INV/${n}`, invoice_date: '2026-10-01', due_date: '2026-10-08', outstanding: '100.00', days_overdue: 4, link: n <= 5 ? `https://x/i/${n}` : null });
    const text = reminderText({ name: 'A', company: 'B', total: '700.00', invoices: [1, 2, 3, 4, 5, 6, 7].map(due), upi: 'radboards@upi' });
    expect(text).toContain('and 2 more');
    expect(text).toContain('You can pay by UPI to radboards@upi.');
    expect(text.match(/https:\/\/x\/i\//g)).toHaveLength(5);
  });
});

describe('the bill as a link', () => {
  it('shows the customer their bill without a sign-in, and nothing of ours beyond it', async () => {
    const sales = await w.as('sales');
    const shared = (await sales.post(`/api/sales/invoices/${id.inv1}/share`).send({}).expect(200)).body.data;
    expect(shared.path).toBe(`/i/${shared.token}`);
    expect((await sales.post(`/api/sales/invoices/${id.inv1}/share`).send({}).expect(200)).body.data.token).toBe(shared.token);

    const open = await request(w.app).get(`/api/public/invoices/${shared.token}`).expect(200);
    const doc = open.body.data;
    expect(doc).toMatchObject({ doc_type: 'tax_invoice', party_name: 'Mumbai Skate Co', grand_total: '11800.00', taxable_total: '10000.00', status: 'issued', payment: { outstanding: '6800.00', payment_status: 'partly_paid' } });
    expect(doc.invoice_no).toMatch(/^INV\//);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ description: 'Board', rate: '1000.00', line_total: '11800.00' });
    expect(doc.company.name).toBe('Radboards Pvt Ltd');
    // What we paid for the goods, our notes and our internal ids are not for the customer.
    const raw = JSON.stringify(open.body);
    expect(raw).not.toMatch(/unit_cost|"notes"|party_id|order_id|created_by|500\.00/);
    await request(w.app).get('/api/public/invoices/not-a-real-token').expect(404);
    await request(w.app).get(`/api/sales/invoices/${id.inv1}`).expect(401);
    await (await w.as('hr')).post(`/api/sales/invoices/${id.inv1}/share`).send({}).expect(403);
  });

  it('leaves the invoice itself untouched: it is still the legal record it was', async () => {
    const [inv] = await rows<{ updated_at: string; created_at: string }>(w.db, sql`select updated_at::text, created_at::text from invoices where id = ${id.inv1}`);
    const [link] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from invoice_links where invoice_id = ${id.inv1}`);
    expect(link!.n).toBe(1);
    expect(inv!.updated_at).toBeTruthy();
    await expect(rows(w.db, sql`update invoices set party_name = 'Someone Else' where id = ${id.inv1}`)).rejects.toThrow();
  });
});

describe('money moved between our own accounts', () => {
  it('moves cash to the bank as one balanced entry, and can be reversed', async () => {
    const accounts = await w.as('accounts');
    const balance = async (accountId: string) =>
      Number((await rows<{ b: string }>(w.db, sql`select coalesce(sum(debit) - sum(credit), 0)::text as b from journal_lines where account_id = ${accountId}`))[0]!.b);
    const cash = m.account('cash');
    const bank = m.account('bank');
    const [cashBefore, bankBefore] = [await balance(cash), await balance(bank)];

    const made = await accounts.post('/api/accounting/transfers').send({ from_account_id: cash, to_account_id: bank, amount: 1000, reference: 'Slip 42', notes: 'Counter cash banked' }).expect(201);
    expect(await balance(cash)).toBe(cashBefore - 1000);
    expect(await balance(bank)).toBe(bankBefore + 1000);
    const list = (await accounts.get('/api/accounting/transfers').expect(200)).body.data;
    expect(list[0]).toMatchObject({ from_account: 'Cash in Hand', to_account: 'Bank Account', amount: '1000.00', reversed: false, narration: 'Cash in Hand to Bank Account · ref Slip 42 · Counter cash banked' });
    // It waits on the bank side to be matched against the statement, like any other bank entry.
    const recon = (await accounts.get(`/api/bank/reconciliation?account_id=${bank}`).expect(200)).body.data;
    expect(recon.unmatched_book_entries.some((e: any) => e.ref_type === 'transfer' && Number(e.amount ?? e.debit ?? 1000) === 1000)).toBe(true);

    await accounts.post('/api/accounting/transfers').send({ from_account_id: cash, to_account_id: cash, amount: 10 }).expect(400);
    await accounts.post('/api/accounting/transfers').send({ from_account_id: cash, to_account_id: m.account('sales'), amount: 10 }).expect(400); // not a cash or bank account
    await accounts.post('/api/accounting/transfers').send({ from_account_id: cash, to_account_id: bank, amount: 0 }).expect(400);
    await (await w.as('sales')).post('/api/accounting/transfers').send({ from_account_id: cash, to_account_id: bank, amount: 10 }).expect(403);

    await accounts.post(`/api/accounting/journals/${made.body.data.id}/reverse`).send({ reason: 'Entered twice' }).expect(200);
    expect(await balance(cash)).toBe(cashBefore);
    expect((await accounts.get('/api/accounting/transfers').expect(200)).body.data[0].reversed).toBe(true);
    await expectBooksHealthy(w);
  });
});

describe('profit on each bill', () => {
  it('is what the goods sold for before GST, less what they cost; a return takes both back out', async () => {
    const accounts = await w.as('accounts');
    const from = addDays(today, -30);
    const before = (await accounts.get(`/api/accounting/reports/invoice-profit?from=${from}&to=${today}`).expect(200)).body;
    const row = before.data.find((r: any) => r.id === id.inv1);
    // Ten boards at 1,000 each that cost 500 each.
    expect(row).toMatchObject({ party_name: 'Mumbai Skate Co', sale: '10000.00', cost: '5000.00', profit: '5000.00' });
    expect(Number(row.margin_pct)).toBe(50);
    // The counter sale: 1,180 including GST is 1,000 before it.
    expect(before.data.find((r: any) => r.party_name === 'Cash Sale')).toMatchObject({ sale: '1000.00', cost: '500.00', profit: '500.00' });
    // 10 + 2 + 5 + 1 + 1 = 19 boards sold.
    expect(before.totals).toEqual({ sale: '19000.00', cost: '9500.00', profit: '9500.00' });

    const inv2 = (await accounts.get(`/api/sales/invoices/${id.inv2}`).expect(200)).body.data;
    await accounts.post(`/api/sales/invoices/${id.inv2}/credit-note`).send({ lines: [{ invoice_line_id: inv2.lines[0].id, qty: 1 }], restock: true, reason: 'Wrong size' }).expect(201);
    const after = (await accounts.get(`/api/accounting/reports/invoice-profit?from=${from}&to=${today}`).expect(200)).body;
    expect(after.data.find((r: any) => r.doc_type === 'credit_note')).toMatchObject({ sale: '-1000.00', cost: '-500.00', profit: '-500.00' });
    expect(after.totals).toEqual({ sale: '18000.00', cost: '9000.00', profit: '9000.00' });
    // Outside the dates asked for there is nothing.
    expect((await accounts.get(`/api/accounting/reports/invoice-profit?from=${addDays(today, 1)}&to=${addDays(today, 2)}`).expect(200)).body.data).toHaveLength(0);
    await (await w.as('sales')).get('/api/accounting/reports/invoice-profit').expect(403);
  });
});
