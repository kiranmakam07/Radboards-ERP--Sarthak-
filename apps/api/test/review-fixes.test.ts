import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, onHand, openingStock, setup, type World } from './helpers';

/**
 * The founder's technical review (26 Oct 2026, "RadCore Technical Review Proposal"): each headline risk
 * that the code bore out, written so it failed before the fix.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const TODAY = istDate();
/** A day in last month: a month whose returns can already be filed. */
const PAST = addDays(`${TODAY.slice(0, 7)}-01`, -3);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const board = await admin.post('/api/items').send({
    sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
    retail_price: 5900, dealer_price: 4000, purchase_cost: 2500,
  }).expect(201);
  id.board = board.body.data.id;
  await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '100', unit_cost: '2500' }]);
  const dealer = await admin.post('/api/parties').send({
    party_type: 'dealer', name: 'Pune Boards', phone: '9700000002', gstin: gstin('27', 'DEALR1234B'), payment_terms_days: 90,
  }).expect(201);
  id.dealer = dealer.body.data.id;
});
afterAll(() => w.close());

describe('stock: a line listed twice', () => {
  it('a delivery naming the same order line twice is refused, so goods cannot leave twice and be recorded once', async () => {
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 5 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
    const line = (await sales.get(`/api/sales/orders/${order.id}`).expect(200)).body.data.lines[0];
    const stores = await w.as('stores');
    const res = await stores.post(`/api/sales/orders/${order.id}/deliver`)
      .send({ lines: [{ order_line_id: line.id, qty: 5 }, { order_line_id: line.id, qty: 5 }] }).expect(400);
    expect(res.body.error.message).toMatch(/listed twice/);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(100);
    // Delivered properly, once.
    await stores.post(`/api/sales/orders/${order.id}/deliver`).send({ lines: [{ order_line_id: line.id, qty: 5 }] }).expect(201);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(95);
    await expectBooksHealthy(w);
  });
});

describe('GST: a filed return is not changed behind it', () => {
  it('once GSTR-1 is filed, an invoice in that month cannot be cancelled or added; a credit note dated today corrects it', async () => {
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, order_date: PAST, lines: [{ item_id: id.board, qty: 2 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
    await (await w.as('stores')).post(`/api/sales/orders/${order.id}/deliver`).send({ date: PAST }).expect(201);
    const inv = (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({ invoice_date: PAST }).expect(201)).body.data;

    const accounts = await w.as('accounts');
    await sales.post('/api/gst/filings').send({ return_type: 'gstr1', period: PAST.slice(0, 7), filed_on: TODAY }).expect(403);
    await accounts.post('/api/gst/filings').send({ return_type: 'gstr1', period: PAST.slice(0, 7), filed_on: TODAY, arn: 'AA271026000001A' }).expect(201);
    await accounts.post('/api/gst/filings').send({ return_type: 'gstr1', period: PAST.slice(0, 7), filed_on: TODAY }).expect(409);

    const refused = await accounts.post(`/api/sales/invoices/${inv.id}/cancel`).send({ reason: 'wrong rate' }).expect(409);
    expect(refused.body.error.message).toMatch(new RegExp(`GSTR-1 for .+ was filed on .+, so ${inv.invoice_no} cannot be cancelled\\. Correct it with a credit note dated today`));
    expect((await accounts.get(`/api/sales/invoices/${inv.id}`).expect(200)).body.data.status).toBe('issued');

    // A second order, invoiced back into the filed month, is refused; dated today it goes through.
    const again = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, order_date: PAST, lines: [{ item_id: id.board, qty: 1 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${again.id}/confirm`).send({}).expect(200);
    await (await w.as('stores')).post(`/api/sales/orders/${again.id}/deliver`).send({ date: PAST }).expect(201);
    await sales.post(`/api/sales/orders/${again.id}/invoice`).send({ invoice_date: PAST }).expect(409);
    await sales.post(`/api/sales/orders/${again.id}/invoice`).send({ invoice_date: TODAY }).expect(201);

    // The correction: a credit note dated today, which goes in this month's return.
    const line = (await accounts.get(`/api/sales/invoices/${inv.id}`).expect(200)).body.data.lines[0];
    await accounts.post(`/api/sales/invoices/${inv.id}/credit-note`).send({ lines: [{ invoice_line_id: line.id, qty: 2 }], reason: 'wrong rate', date: PAST }).expect(409);
    await accounts.post(`/api/sales/invoices/${inv.id}/credit-note`).send({ lines: [{ invoice_line_id: line.id, qty: 2 }], reason: 'wrong rate' }).expect(201);
    await expectBooksHealthy(w);
  });

  it('only the owner or an admin takes a filed mark back, with a reason, and it is audited', async () => {
    const filing = (await (await w.as('accounts')).get('/api/gst/filings').expect(200)).body.data[0];
    expect(filing).toMatchObject({ return_type: 'gstr1', period: PAST.slice(0, 7), arn: 'AA271026000001A' });
    await (await w.as('accounts')).post(`/api/gst/filings/${filing.id}/undo`).send({ reason: 'revised' }).expect(403);
    await (await w.as('owner')).post(`/api/gst/filings/${filing.id}/undo`).send({}).expect(400);
    await (await w.as('owner')).post(`/api/gst/filings/${filing.id}/undo`).send({ reason: 'marked by mistake' }).expect(200);
    const [log] = await rows<{ after: { reason: string } }>(w.db, sql`select after from audit_log where entity = 'gst_filing' and action = 'undo'`);
    expect(log!.after.reason).toBe('marked by mistake');
  });

  it('once GSTR-3B is filed, a purchase bill in that month cannot be cancelled or added', async () => {
    const admin = await w.as('admin');
    const svc = (await admin.post('/api/items').send({ sku: 'SVC-AUDIT', name: 'Audit fee', item_type: 'service', hsn_sac: '998221', gst_rate: 18 }).expect(201)).body.data.id;
    const ca = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Shah and Co', phone: '9700000044', gstin: gstin('27', 'SHAHC1234D') }).expect(201)).body.data.id;
    const accounts = await w.as('accounts');
    const bill = (await accounts.post('/api/purchasing/bills').send({ supplier_id: ca, supplier_invoice_no: 'SC/77', bill_date: PAST, lines: [{ item_id: svc, qty: 1, rate: 10000 }] }).expect(201)).body.data;
    await accounts.post('/api/gst/filings').send({ return_type: 'gstr3b', period: PAST.slice(0, 7), filed_on: TODAY }).expect(201);
    const refused = await accounts.post(`/api/purchasing/bills/${bill.id}/cancel`).send({ reason: 'duplicate' }).expect(409);
    expect(refused.body.error.message).toMatch(/GSTR-3B for .+ was filed on .+cannot be cancelled/);
    await accounts.post('/api/purchasing/bills').send({ supplier_id: ca, supplier_invoice_no: 'SC/78', bill_date: PAST, lines: [{ item_id: svc, qty: 1, rate: 500 }] }).expect(409);
  });
});

describe('GST: buying from outside India', () => {
  it('a bill from a supplier outside India, or in dollars, carries no Indian GST and claims none', async () => {
    const admin = await w.as('admin');
    const svc = (await admin.post('/api/items').send({ sku: 'SVC-DSN', name: 'Design work', item_type: 'service', hsn_sac: '998391', gst_rate: 18 }).expect(201)).body.data.id;
    const abroad = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Shenzhen Design Ltd', phone: '9700000055', state_code: '96' }).expect(201)).body.data;
    expect(abroad.state_code).toBe('96');
    const accounts = await w.as('accounts');
    const inputGst = async () => Number((await rows<{ v: string }>(w.db, sql`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as v from journal_lines jl join accounts a on a.id = jl.account_id
       where a.system_key in ('input_cgst', 'input_sgst', 'input_igst')`))[0]!.v);
    const before = await inputGst();
    const bill = (await accounts.post('/api/purchasing/bills').send({
      supplier_id: abroad.id, supplier_invoice_no: 'SDL-9', bill_date: TODAY, currency: 'USD', fx_rate: 84, lines: [{ item_id: svc, qty: 1, rate: 500 }],
    }).expect(201)).body.data;
    expect(bill).toMatchObject({ taxable_total: '42000.00', cgst_total: '0.00', sgst_total: '0.00', igst_total: '0.00', grand_total: '42000.00' });
    expect(await inputGst()).toBe(before);

    // A supplier outside India billing in rupees is still an import.
    const inr = (await accounts.post('/api/purchasing/bills').send({ supplier_id: abroad.id, supplier_invoice_no: 'SDL-10', bill_date: TODAY, lines: [{ item_id: svc, qty: 1, rate: 1000 }] }).expect(201)).body.data;
    expect(inr.grand_total).toBe('1000.00');
    expect(await inputGst()).toBe(before);
    await expectBooksHealthy(w);
  });

  it('a PO to a supplier outside India has no GST on its lines; nothing is sold outside India yet', async () => {
    const admin = await w.as('admin');
    const abroad = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Ningbo Cells', phone: '9700000066', state_code: '96' }).expect(201)).body.data.id;
    const po = (await (await w.as('stores')).post('/api/purchasing/orders').send({ supplier_id: abroad, currency: 'USD', fx_rate: 84, lines: [{ item_id: id.board, qty: 10, rate: 20 }] }).expect(201)).body.data;
    const lines = (await admin.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines;
    expect(lines[0]).toMatchObject({ rate: '1680.00' });
    expect(Number(lines[0].gst_rate)).toBe(0);
    const buyer = (await admin.post('/api/parties').send({ party_type: 'customer', name: 'Dubai Rider', phone: '9700000077', state_code: '96' }).expect(201)).body.data.id;
    const refused = await (await w.as('sales')).post('/api/sales/orders').send({ channel: 'dealer', party_id: buyer, lines: [{ item_id: id.board, qty: 1 }] }).expect(400);
    expect(refused.body.error.message).toMatch(/outside India/);
  });
});

describe('payroll: leave, past salaries, and nobody handling their own pay', () => {
  // June 2026: 30 days, Sundays on the 7th, 14th, 21st and 28th (weekly offs by the attendance rules).
  const JUNE = '2026-06';
  const day = (n: number) => `${JUNE}-${String(n).padStart(2, '0')}`;
  const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => ![7, 14, 21, 28].includes(n));

  it('pays leave up to the allowance only, at the salary in force that month, and the approver is never paid in it', async () => {
    const admin = await w.as('admin');
    const [hrUser] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'hr'`);
    const employee = async (name: string, phone: string, userId: string) =>
      (await admin.post('/api/hr/employees').send({ name, phone, department: 'Workshop', designation: 'Staff', join_date: '2025-01-01', user_id: userId, annual_leave_days: 2 }).expect(201)).body.data.id as string;
    id.raju = await employee('Raju Fitter', '9822200101', '');
    id.neha = await employee('Neha HR', '9822200102', hrUser!.id);
    const pay = (employeeId: string, body: Record<string, unknown>) => admin.put(`/api/payroll/staff/${employeeId}`)
      .send({ pf_applicable: false, esic_applicable: false, pt_monthly: 0, tds_monthly: 0, bank_account_no: '', bank_ifsc: '', ...body });
    await pay(id.raju!, { monthly_salary: 30000, bank_account_no: '50100123456789', bank_ifsc: 'HDFC0001234' }).expect(200);
    await pay(id.neha!, { monthly_salary: 31000 }).expect(200);

    // Raju took one day of leave in May; in June he takes three more. His allowance is two a year.
    const hr = await w.as('hr');
    await hr.put('/api/hr/attendance').send({ date: '2026-05-05', entries: [{ employee_id: id.raju, status: 'leave' }] }).expect(200);
    for (const n of WORKING) {
      await hr.put('/api/hr/attendance').send({ date: day(n), entries: [{ employee_id: id.raju, status: [2, 3, 4].includes(n) ? 'leave' : 'present' }] }).expect(200);
      // HR's own days are marked by someone else.
      await admin.put('/api/hr/attendance').send({ date: day(n), entries: [{ employee_id: id.neha, status: 'present' }] }).expect(200);
    }

    const accounts = await w.as('accounts');
    id.june = (await accounts.post('/api/payroll/runs').send({ month: JUNE }).expect(201)).body.data.id;
    const slip = async (name: string) => (await accounts.get(`/api/payroll/runs/${id.june}`).expect(200)).body.data.payslips.find((x: any) => x.employee_name === name);
    // 3 days of leave, 1 paid (2 a year, 1 used in May), 2 not: 28 paid days of 30. 30,000 x 28 / 30 = 28,000.
    expect(await slip('Raju Fitter')).toMatchObject({ leave_days: 3, unpaid_leave: '2.0', paid_days: '28.0', monthly_salary: '30000.00', gross_earned: '28000.00' });

    // HR's own salary is in June: HR cannot approve it, change it or pay it. Accounts can.
    expect((await hr.post(`/api/payroll/runs/${id.june}/approve`).send({}).expect(403)).body.error.message).toMatch(/Your own salary is in this month/);
    await hr.patch(`/api/payroll/payslips/${(await slip('Neha HR')).id}`).send({ other_earning: 5000, other_deduction: 0, note: 'Bonus' }).expect(403);
    await accounts.post(`/api/payroll/runs/${id.june}/approve`).send({}).expect(200);
    await hr.post(`/api/payroll/runs/${id.june}/pay`).send({ paid_from_account_id: m.account('bank') }).expect(403);

    // A raise from July. June, reopened and approved again, is still paid at June's salary.
    await pay(id.raju!, { monthly_salary: 36000, salary_from: '2026-07-01', bank_account_no: '50100123456789', bank_ifsc: 'HDFC0001234' }).expect(200);
    await accounts.post(`/api/payroll/runs/${id.june}/reopen`).send({}).expect(200);
    await accounts.post(`/api/payroll/runs/${id.june}/approve`).send({}).expect(200);
    expect(await slip('Raju Fitter')).toMatchObject({ monthly_salary: '30000.00', gross_earned: '28000.00' });
    await expectBooksHealthy(w);
  });

  it('a raise from the middle of a month counts from that day', async () => {
    const admin = await w.as('admin');
    await admin.put(`/api/payroll/staff/${id.raju}`).send({ monthly_salary: 40000, salary_from: '2026-08-16', pf_applicable: false, esic_applicable: false, pt_monthly: 0, tds_monthly: 0, bank_account_no: '50100123456789', bank_ifsc: 'HDFC0001234' }).expect(200);
    const august = (await (await w.as('accounts')).post('/api/payroll/runs').send({ month: '2026-08' }).expect(201)).body.data.id;
    const run = (await (await w.as('accounts')).get(`/api/payroll/runs/${august}`).expect(200)).body.data;
    // 15 days at 36,000 (from 1 July) and 16 at 40,000, over 31 days: 38,064.52 a month for August.
    expect(run.payslips.find((x: any) => x.employee_name === 'Raju Fitter').monthly_salary).toBe('38064.52');
  });

  it('a payslip link shows only the last four digits of the bank account, and stops working after 30 days', async () => {
    const accounts = await w.as('accounts');
    const raju = (await accounts.get(`/api/payroll/runs/${id.june}`).expect(200)).body.data.payslips.find((x: any) => x.employee_name === 'Raju Fitter');
    const shared = (await accounts.post(`/api/payroll/payslips/${raju.id}/share`).send({}).expect(200)).body.data;
    const open = (await request(w.app).get(`/api/public/payslips/${shared.token}`).expect(200)).body.data;
    expect(open.bank_account_no).toBe('••••••••••6789');
    expect(JSON.stringify(open)).not.toContain('50100123456789');
    expect(open.net_pay).toBe(raju.net_pay);
    // Sent again while it works: the same link.
    expect((await accounts.post(`/api/payroll/payslips/${raju.id}/share`).send({}).expect(200)).body.data.token).toBe(shared.token);
    await rows(w.db, sql`update payslips set token_expires_at = now() - interval '1 day' where id = ${raju.id}`);
    expect((await request(w.app).get(`/api/public/payslips/${shared.token}`).expect(410)).body.error.message).toMatch(/expired/);
    const fresh = (await accounts.post(`/api/payroll/payslips/${raju.id}/share`).send({}).expect(200)).body.data.token;
    expect(fresh).not.toBe(shared.token);
    await request(w.app).get(`/api/public/payslips/${shared.token}`).expect(404);
    await request(w.app).get(`/api/public/payslips/${fresh}`).expect(200);
  });
});

describe('who can do what', () => {
  it('a role given user management still cannot make anyone an admin, or touch an admin\'s sign-in', async () => {
    const admin = await w.as('admin');
    await admin.put('/api/settings/permissions/users:manage').send({ roles: ['hr'] }).expect(200);
    const hr = await w.as('hr');
    const [me] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'hr'`);
    const [boss] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'admin'`);
    expect((await hr.patch(`/api/users/${me!.id}`).send({ role: 'admin' }).expect(403)).body.error.message).toMatch(/Only an admin can give someone the admin role/);
    await hr.patch(`/api/users/${me!.id}`).send({ role: 'accounts' }).expect(400); // nor any other role for themselves
    await hr.post('/api/users').send({ name: 'New Admin', phone: '9811100001', role: 'admin', password: 'Long-enough-1' }).expect(403);
    await hr.patch(`/api/users/${boss!.id}`).send({ password: 'Taken-over-123' }).expect(403);
    await hr.post('/api/users').send({ name: 'New Sales', phone: '9811100002', role: 'sales', password: 'Long-enough-1' }).expect(201);
    await admin.put('/api/settings/permissions/users:manage').send({ roles: [] }).expect(200);
  });
});

describe('credit: orders not yet billed count against the limit', () => {
  it('two orders that each fit inside the limit cannot both be confirmed when together they do not', async () => {
    const admin = await w.as('admin');
    const dealer = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Nashik Rides', phone: '9700000088', credit_limit: 50000, payment_terms_days: 30 }).expect(201)).body.data.id;
    const sales = await w.as('sales');
    const order = async (qty: number) => (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: dealer, lines: [{ item_id: id.board, qty }] }).expect(201)).body.data.id;
    // 8 boards at 4,000 + 18% GST = 37,760, confirmed but not delivered or billed yet.
    await sales.post(`/api/sales/orders/${await order(8)}/confirm`).send({}).expect(200);
    // 3 more = 14,160: 51,920 in all, over the 50,000 limit.
    const second = await order(3);
    const refused = await sales.post(`/api/sales/orders/${second}/confirm`).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/would be at 51920\.00 against a credit limit of 50000\.00 \(₹37,760\.00 of it on orders not yet billed\)/);
    // 2 more = 9,440 fits (47,200).
    await sales.post(`/api/sales/orders/${await order(2)}/confirm`).send({}).expect(200);
  });
});

describe('a save sent twice is done once', () => {
  it('two requests for the same payment with the same key make one payment, and the second gets the first answer', async () => {
    const accounts = await w.as('accounts');
    const count = async () => Number((await rows<{ n: string }>(w.db, sql`select count(*)::text as n from payments`))[0]!.n);
    const before = await count();
    const body = { direction: 'in', party_id: id.dealer, mode: 'upi', amount: 1000, reference: 'UPI-DOUBLE' };
    const key = 'b6f1c2d0-0000-4000-8000-000000000001-1';
    const first = await accounts.post('/api/payments').set('Idempotency-Key', key).send(body).expect(201);
    const again = await accounts.post('/api/payments').set('Idempotency-Key', key).send(body).expect(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.data.payment_no).toBe(first.body.data.payment_no);
    expect(await count()).toBe(before + 1);
    // Without a key, or with a new one, it is a new payment; the same key on another request is refused.
    await accounts.post('/api/payments').set('Idempotency-Key', 'b6f1c2d0-0000-4000-8000-000000000002-1').send(body).expect(201);
    expect(await count()).toBe(before + 2);
    await accounts.post('/api/accounting/expenses').set('Idempotency-Key', key).send({}).expect(409);
    // A refused save keeps nothing: the corrected one goes through with the same key.
    const k3 = 'b6f1c2d0-0000-4000-8000-000000000003-1';
    await accounts.post('/api/payments').set('Idempotency-Key', k3).send({ ...body, amount: -5 }).expect(400);
    await accounts.post('/api/payments').set('Idempotency-Key', k3).send(body).expect(201);
    await expectBooksHealthy(w);
  });
});

describe('alarms and the jobs that run by themselves', () => {
  it('runs the background jobs on a scheduler’s call with the secret, records a failing one, and sends it to the alert channel', async () => {
    const { config } = await import('../src/config');
    const { runJobs } = await import('../src/core/jobs');
    const http = await import('node:http');
    const received: string[] = [];
    const channel = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(body); res.end('ok'); });
    });
    await new Promise<void>((r) => channel.listen(0, '127.0.0.1', () => r()));
    const before = { cron: config.cronSecret, hook: config.alertWebhookUrl };
    config.cronSecret = 'a-cron-secret-for-the-test-only';
    config.alertWebhookUrl = `http://127.0.0.1:${(channel.address() as { port: number }).port}/hook`;
    try {
      await request(w.app).post('/api/hooks/jobs/run').expect(404);
      await request(w.app).post('/api/hooks/jobs/run').set('Authorization', 'Bearer wrong').expect(404);
      const ok = (await request(w.app).post('/api/hooks/jobs/run').set('Authorization', `Bearer ${config.cronSecret}`).expect(200)).body.data;
      expect(ok).toMatchObject({ reservations: 'done', bank_mail: 'no mailbox connected', housekeeping: 'done' });
      expect(ok.daily_tasks).toMatch(/task\(s\) made/);

      // The mailbox cannot be reached: that job fails, the others still run, and someone is told.
      const result = await runJobs(w.db, { readMailbox: async () => { throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); } });
      expect(result.bank_mail).toMatch(/^failed: The statements mailbox could not be read/);
      expect(result.housekeeping).toBe('done');
      const [kept] = await rows<{ source: string; message: string }>(w.db, sql`select source, message from error_log order by at desc limit 1`);
      expect(kept).toMatchObject({ source: 'job:bank_mail' });
      expect(received.some((b) => /job:bank_mail/.test(b))).toBe(true);

      // System health shows it, to the owner and admins only.
      const health = (await (await w.as('owner')).get('/api/settings/health').expect(200)).body.data;
      expect(health).toMatchObject({ alerts_on: true, scheduler: 'server' });
      expect(health.errors[0].source).toBe('job:bank_mail');
      expect(health.jobs.result.housekeeping).toBe('done');
      await (await w.as('accounts')).get('/api/settings/health').expect(403);
      await (await w.as('admin')).post('/api/settings/health/test-alert').send({}).expect(200);
      expect(received.some((b) => /a test alert/.test(b))).toBe(true);
    } finally {
      config.cronSecret = before.cron;
      config.alertWebhookUrl = before.hook;
      channel.close();
    }
  });
});

describe('a sign-in in use stays signed in', () => {
  it('renews a session past half its life when it is used, so nobody is signed out in the middle of work', async () => {
    const sales = await w.as('sales');
    const [u] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'sales'`);
    await rows(w.db, sql`update sessions set expires_at = now() + interval '1 day' where user_id = ${u!.id}`);
    const res = await sales.get('/api/auth/me').expect(200);
    expect(String(res.headers['set-cookie'] ?? '')).toMatch(/Max-Age=/);
    const [s] = await rows<{ days: number }>(w.db, sql`
      select extract(epoch from max(expires_at) - now()) / 86400 as days from sessions where user_id = ${u!.id}`);
    expect(Number(s!.days)).toBeGreaterThan(13);
    // A session used again soon after is not touched.
    expect((await sales.get('/api/auth/me').expect(200)).headers['set-cookie']).toBeUndefined();
  });
});
