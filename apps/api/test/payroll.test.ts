import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, masters, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

// June 2026: 30 days, Sundays on the 7th, 14th, 21st and 28th, so 26 working days.
const MONTH = '2026-06';
const day = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;
const SUNDAYS = [7, 14, 21, 28];
const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => !SUNDAYS.includes(n));

/** Debit less credit on an account: what it holds (assets, expenses) or, negative, what is owed (liabilities). */
const balance = async (key: string) =>
  Number((await rows<{ b: string }>(w.db, sql`select coalesce(sum(debit) - sum(credit), 0)::text as b from journal_lines where account_id = ${m.account(key)}`))[0]!.b);
const slipOf = (run: any, name: string) => run.payslips.find((s: any) => s.employee_name === name);
const getRun = async () => (await (await w.as('accounts')).get(`/api/payroll/runs/${id.run}`).expect(200)).body.data;

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const hr = await w.as('hr');
  const user = async (role: string) => (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;
  const employee = async (name: string, phone: string, joined: string, role: string | null) =>
    (await hr.post('/api/hr/employees').send({ name, phone, department: 'Sales', designation: 'Executive', join_date: joined, user_id: role ? await user(role) : '' }).expect(201)).body.data.id as string;
  id.amit = await employee('Amit Verma', '9822200001', '2025-01-01', 'sales');
  id.sunita = await employee('Sunita Rao', '9822200002', '2025-01-01', 'store');
  id.kiran = await employee('Kiran Joshi', '9822200003', day(16), null); // joined part-way through the month
  id.ganesh = await employee('Ganesh Pawar', '9822200004', '2025-01-01', null); // no salary set

  // The register for June. Amit: absent on the 10th, a half day on the 11th, on leave on the 12th.
  // Sunita: every working day, the 15th a holiday, and the first Sunday marked as her weekly off.
  // Kiran: from the 16th, with the last two days of the month not marked yet.
  for (const n of [...WORKING, 7]) {
    const entries: { employee_id: string; status: string }[] = [];
    if (n !== 7) entries.push({ employee_id: id.amit!, status: n === 10 ? 'absent' : n === 11 ? 'half_day' : n === 12 ? 'leave' : 'present' });
    entries.push({ employee_id: id.sunita!, status: n === 7 ? 'weekly_off' : n === 15 ? 'holiday' : 'present' });
    if (n >= 16 && n <= 27 && n !== 21) entries.push({ employee_id: id.kiran!, status: 'present' });
    await hr.put('/api/hr/attendance').send({ date: day(n), entries }).expect(200);
  }
});
afterAll(async () => {
  await w.close();
});

describe('who is paid what', () => {
  it('keeps each person’s salary, deductions and bank details, and is not open to everyone', async () => {
    const accounts = await w.as('accounts');
    const pay = (employeeId: string, body: Record<string, unknown>) =>
      accounts.put(`/api/payroll/staff/${employeeId}`).send({ monthly_salary: null, pf_applicable: false, esic_applicable: false, pt_monthly: 0, tds_monthly: 0, bank_account_no: '', bank_ifsc: '', ...body });
    await pay(id.amit!, { monthly_salary: 30000, pf_applicable: true, pt_monthly: 200, bank_account_no: '50100123456789', bank_ifsc: 'hdfc0001234' }).expect(200);
    await pay(id.sunita!, { monthly_salary: 18000, esic_applicable: true }).expect(200);
    await pay(id.kiran!, { monthly_salary: 20000 }).expect(200);
    await pay(id.amit!, { monthly_salary: 30000, bank_ifsc: 'NOT-AN-IFSC' }).expect(400);
    await pay(id.amit!, { monthly_salary: 30000, bank_account_no: '12ab' }).expect(400);

    const staff = (await accounts.get('/api/payroll/staff').expect(200)).body.data;
    expect(staff.find((e: any) => e.name === 'Amit Verma')).toMatchObject({ monthly_salary: '30000.00', pf_applicable: true, pt_monthly: '200.00', bank_ifsc: 'HDFC0001234', advance_outstanding: '0.00' });
    await (await w.as('sales')).get('/api/payroll/staff').expect(403);
    await (await w.as('owner')).get('/api/payroll/staff').expect(200);
    await (await w.as('owner')).put(`/api/payroll/staff/${id.amit}`).send({}).expect(403); // the owner looks; accounts and HR change
  });

  it('gives an advance out of cash and remembers what is still to come back', async () => {
    const accounts = await w.as('accounts');
    const body = { employee_id: id.sunita, amount: 5000, monthly_recovery: 2000, given_on: '2026-05-20', paid_from_account_id: m.account('cash'), note: 'School fees' };
    await accounts.post('/api/payroll/advances').send({ ...body, monthly_recovery: 6000 }).expect(400); // more a month than the advance itself
    await accounts.post('/api/payroll/advances').send({ ...body, paid_from_account_id: m.account('sales') }).expect(409); // not a cash or bank account
    const mistake = await accounts.post('/api/payroll/advances').send({ ...body, amount: 9000 }).expect(201);
    await accounts.post(`/api/payroll/advances/${mistake.body.data.id}/cancel`).send({}).expect(200);
    await accounts.post(`/api/payroll/advances/${mistake.body.data.id}/cancel`).send({}).expect(409);
    id.advance = (await accounts.post('/api/payroll/advances').send(body).expect(201)).body.data.id;

    expect(await balance('staff_advances')).toBe(5000);
    expect(await balance('cash')).toBe(-5000);
    const list = (await accounts.get('/api/payroll/advances').expect(200)).body.data;
    expect(list[0]).toMatchObject({ name: 'Sunita Rao', amount: '5000.00', recovered: '0.00', outstanding: '5000.00', paid_from: 'Cash in Hand' });
    expect((await accounts.get('/api/payroll/staff').expect(200)).body.data.find((e: any) => e.name === 'Sunita Rao').advance_outstanding).toBe('5000.00');
  });
});

describe('the month’s salary', () => {
  it('works each person’s pay out from the register', async () => {
    const accounts = await w.as('accounts');
    await accounts.post('/api/payroll/runs').send({ month: '2099-01' }).expect(400);
    await accounts.post('/api/payroll/runs').send({ month: 'June' }).expect(400);
    id.run = (await accounts.post('/api/payroll/runs').send({ month: MONTH }).expect(201)).body.data.id;
    await accounts.post('/api/payroll/runs').send({ month: MONTH }).expect(409);

    const run = await getRun();
    expect(run).toMatchObject({ status: 'draft', month_name: 'June 2026' });
    expect(run.payslips.map((s: any) => s.employee_name)).toEqual(['Amit Verma', 'Kiran Joshi', 'Sunita Rao']);
    expect(run.no_salary.map((e: any) => e.name)).toEqual(['Ganesh Pawar']);

    // Amit: 23 days present, a half day, a day of leave, 4 Sundays = 28.5 paid days. 30,000 x 28.5 / 30 = 28,500.
    // PF 12% of Basic 14,250 = 1,710; professional tax 200.
    expect(slipOf(run, 'Amit Verma')).toMatchObject({
      days_in_month: 30, paid_days: '28.5', present: 23, half_days: 1, leave_days: 1, absent: 1, weekly_off: 4, not_marked: 0,
      gross_earned: '28500.00', basic_earned: '14250.00', pf_employee: '1710.00', pf_employer: '1710.00', pt: '200.00', net_pay: '26590.00',
      bank_account_no: '50100123456789', bank_ifsc: 'HDFC0001234',
    });
    // Sunita: the whole month (a holiday and the Sundays are paid). ESIC 0.75% of 18,000 = 135; 2,000 of her advance comes back.
    expect(slipOf(run, 'Sunita Rao')).toMatchObject({
      paid_days: '30.0', present: 25, holidays: 1, weekly_off: 4, gross_earned: '18000.00', esic_employee: '135.00', esic_employer: '585.00',
      advance_recovery: '2000.00', net_pay: '15865.00',
    });
    // Kiran joined on the 16th: 11 days present and 2 Sundays are paid; the 29th and 30th are not marked, so not paid yet.
    expect(slipOf(run, 'Kiran Joshi')).toMatchObject({ paid_days: '13.0', present: 11, weekly_off: 2, not_marked: 2, gross_earned: '8666.67', net_pay: '8666.67' });
    expect(run.totals).toMatchObject({ earnings: '55166.67', net_pay: '51121.67', not_marked: 2 });
  });

  it('adds a bonus or takes off a fine, and says what for', async () => {
    const accounts = await w.as('accounts');
    const amit = slipOf(await getRun(), 'Amit Verma');
    await accounts.patch(`/api/payroll/payslips/${amit.id}`).send({ other_earning: 1000, other_deduction: 0, note: '' }).expect(400);
    await accounts.patch(`/api/payroll/payslips/${amit.id}`).send({ other_earning: 1000, other_deduction: 0, note: 'Festival bonus' }).expect(200);
    expect(slipOf(await getRun(), 'Amit Verma')).toMatchObject({ other_earning: '1000.00', net_pay: '27590.00', note: 'Festival bonus' });
  });

  it('will not put unmarked days in the books without being told to, and follows the register when it is completed', async () => {
    const accounts = await w.as('accounts');
    const refused = await accounts.post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/1 person has working days nobody marked in the register \(Kiran Joshi: 2\)/);
    expect(await balance('salaries')).toBe(0);

    const hr = await w.as('hr');
    for (const n of [29, 30]) await hr.put('/api/hr/attendance').send({ date: day(n), entries: [{ employee_id: id.kiran, status: 'present' }] }).expect(200);
    await accounts.post(`/api/payroll/runs/${id.run}/recalculate`).send({}).expect(200);
    // 13 days present + 2 Sundays = 15 of 30 days: half of 20,000. The bonus entered for Amit is still there.
    const run = await getRun();
    expect(slipOf(run, 'Kiran Joshi')).toMatchObject({ paid_days: '15.0', not_marked: 0, gross_earned: '10000.00', net_pay: '10000.00' });
    expect(slipOf(run, 'Amit Verma').net_pay).toBe('27590.00');
    expect(run.totals).toMatchObject({ earnings: '57500.00', pf: '1710.00', esic: '135.00', pt: '200.00', advances: '2000.00', net_pay: '53455.00', employer_pf: '1710.00', employer_esic: '585.00', cost_to_company: '59795.00' });
  });

  it('puts the approved month in the books as one balanced entry, and takes the advance off', async () => {
    const accounts = await w.as('accounts');
    await (await w.as('sales')).post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(403);
    expect((await (await w.as('sales')).get('/api/payroll/me').expect(200)).body.data).toEqual([]); // nothing to see while it is a draft

    const approved = (await accounts.post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(200)).body.data;
    expect(approved).toMatchObject({ status: 'approved', booked_on: day(30) });
    // Salaries 57,500 + employer's PF 1,710 + employer's ESIC 585.
    expect(await balance('salaries')).toBe(59795);
    expect(await balance('pf_payable')).toBe(-3420); // 1,710 from Amit and 1,710 from us
    expect(await balance('esic_payable')).toBe(-720); // 135 + 585
    expect(await balance('pt_payable')).toBe(-200);
    expect(await balance('tds_payable')).toBe(0);
    expect(await balance('staff_advances')).toBe(3000); // 5,000 less the 2,000 taken back
    expect(await balance('salaries_payable')).toBe(-53455);
    expect((await accounts.get('/api/payroll/advances').expect(200)).body.data[0]).toMatchObject({ recovered: '2000.00', outstanding: '3000.00' });

    // From here the payslips are fixed.
    await accounts.post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(409);
    await accounts.post(`/api/payroll/runs/${id.run}/recalculate`).send({}).expect(409);
    await accounts.patch(`/api/payroll/payslips/${slipOf(await getRun(), 'Amit Verma').id}`).send({ other_earning: 0, other_deduction: 0, note: null }).expect(409);
    await accounts.delete(`/api/payroll/runs/${id.run}`).expect(409);
    await accounts.post(`/api/payroll/advances/${id.advance}/cancel`).send({}).expect(409); // part of it has come back
    await expectBooksHealthy(w);
  });

  it('shows each person their own payslip, and sends it as a link', async () => {
    const sales = await w.as('sales'); // Amit's sign-in
    const mine = (await sales.get('/api/payroll/me').expect(200)).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ month: MONTH, net_pay: '27590.00', status: 'approved' });
    const doc = (await sales.get(`/api/payroll/my-payslips/${mine[0].id}`).expect(200)).body.data;
    expect(doc).toMatchObject({ employee_name: 'Amit Verma', month_name: 'June 2026', total_earnings: '29500.00', total_deductions: '1910.00', net_pay: '27590.00', net_in_words: 'Rupees Twenty Seven Thousand Five Hundred Ninety Only' });
    await (await w.as('store')).get(`/api/payroll/my-payslips/${mine[0].id}`).expect(404); // somebody else's
    await sales.get(`/api/payroll/payslips/${mine[0].id}`).expect(403); // the payroll screens are not theirs

    const accounts = await w.as('accounts');
    const link = (await accounts.post(`/api/payroll/payslips/${mine[0].id}/share`).send({}).expect(200)).body.data;
    expect(link).toMatchObject({ path: `/p/${link.token}`, phone: '+919822200001', name: 'Amit Verma', month_name: 'June 2026', net_pay: '27590.00' });
    expect((await accounts.post(`/api/payroll/payslips/${mine[0].id}/share`).send({}).expect(200)).body.data.token).toBe(link.token);
    const open = await request(w.app).get(`/api/public/payslips/${link.token}`).expect(200);
    expect(open.body.data).toMatchObject({ employee_name: 'Amit Verma', net_pay: '27590.00', company: { name: 'Radboards Pvt Ltd' } });
    expect(JSON.stringify(open.body)).not.toMatch(/employee_id|run_id|"token"/);
    await request(w.app).get('/api/public/payslips/not-a-real-token').expect(404);
    id.link = link.token;
  });

  it('can be taken back to correct, which undoes the entry and the recovery', async () => {
    const accounts = await w.as('accounts');
    await accounts.post(`/api/payroll/runs/${id.run}/reopen`).send({}).expect(200);
    expect(await balance('salaries')).toBe(0);
    expect(await balance('salaries_payable')).toBe(0);
    expect(await balance('staff_advances')).toBe(5000);
    await request(w.app).get(`/api/public/payslips/${id.link}`).expect(404); // not shown while it is being corrected
    await accounts.post(`/api/payroll/runs/${id.run}/reopen`).send({}).expect(409);

    await accounts.post(`/api/payroll/runs/${id.run}/approve`).send({}).expect(200);
    expect(await balance('salaries')).toBe(59795);
    expect(await balance('staff_advances')).toBe(3000);
    await request(w.app).get(`/api/public/payslips/${id.link}`).expect(200);
  });

  it('pays the net salaries from the bank, and gives the list the bank needs', async () => {
    const accounts = await w.as('accounts');
    const bankBefore = await balance('bank');
    await accounts.post(`/api/payroll/runs/${id.run}/pay`).send({ paid_from_account_id: m.account('sales') }).expect(409);
    const paid = (await accounts.post(`/api/payroll/runs/${id.run}/pay`).send({ paid_from_account_id: m.account('bank'), paid_on: '2026-07-01', reference: 'NEFT batch 77' }).expect(200)).body.data;
    expect(paid).toMatchObject({ status: 'paid', paid_on: '2026-07-01', payment_reference: 'NEFT batch 77' });
    expect(await balance('salaries_payable')).toBe(0);
    expect(await balance('bank')).toBe(bankBefore - 53455);
    await accounts.post(`/api/payroll/runs/${id.run}/pay`).send({ paid_from_account_id: m.account('bank') }).expect(409);
    await accounts.post(`/api/payroll/runs/${id.run}/reopen`).send({}).expect(409);

    const list = (await accounts.get(`/api/payroll/runs/${id.run}/bank-file`).expect(200)).body.data;
    expect(list.map((r: any) => [r.name, r.amount])).toEqual([['Amit Verma', '27590.00'], ['Kiran Joshi', '10000.00'], ['Sunita Rao', '15865.00']]);
    expect(list[0]).toMatchObject({ account_no: '50100123456789', ifsc: 'HDFC0001234', remarks: 'Salary June 2026' });
    const runs = (await accounts.get('/api/payroll/runs').expect(200)).body.data;
    expect(runs[0]).toMatchObject({ month: MONTH, status: 'paid', people: 3, net_pay: '53455.00' });
    await expectBooksHealthy(w);
  });

  it('carries what is left of an advance into the next month, never taking more than is earned', async () => {
    const accounts = await w.as('accounts');
    // July 2026 with nothing marked: only its 4 Sundays are paid. Sunita earns 18,000 x 4 / 31 = 2,322.58;
    // ESIC is 18 (17.42 rounded up); the 2,000 due on her advance fits in what is left.
    const july = (await accounts.post('/api/payroll/runs').send({ month: '2026-07' }).expect(201)).body.data.id;
    const run = (await accounts.get(`/api/payroll/runs/${july}`).expect(200)).body.data;
    expect(slipOf(run, 'Sunita Rao')).toMatchObject({ paid_days: '4.0', not_marked: 27, gross_earned: '2322.58', esic_employee: '18.00', advance_recovery: '2000.00', net_pay: '304.58' });
    // A draft started by mistake can simply be removed.
    await accounts.delete(`/api/payroll/runs/${july}`).expect(200);
    expect((await accounts.get('/api/payroll/runs').expect(200)).body.data).toHaveLength(1);
  });

  it('works to rules that can be changed', async () => {
    const accounts = await w.as('accounts');
    const rules = (await accounts.get('/api/payroll/rules').expect(200)).body.data;
    expect(rules).toEqual({ basic_pct: 50, pf_rate: 12, pf_wage_ceiling: 15000, esic_employee_rate: 0.75, esic_employer_rate: 3.25, esic_gross_limit: 21000 });
    await accounts.put('/api/payroll/rules').send({ ...rules, basic_pct: 40 }).expect(200);
    const july = (await accounts.post('/api/payroll/runs').send({ month: '2026-07' }).expect(201)).body.data.id;
    const amit = slipOf((await accounts.get(`/api/payroll/runs/${july}`).expect(200)).body.data, 'Amit Verma');
    // 30,000 x 4 / 31 = 3,870.97; Basic at 40% = 1,548.39; PF 12% = 186 (185.81 to the nearest rupee).
    expect(amit).toMatchObject({ gross_earned: '3870.97', basic_earned: '1548.39', pf_employee: '186.00' });
    await accounts.put('/api/payroll/rules').send({ ...rules, basic_pct: 140 }).expect(400);
    await (await w.as('owner')).put('/api/payroll/rules').send(rules).expect(403);
  });
});
