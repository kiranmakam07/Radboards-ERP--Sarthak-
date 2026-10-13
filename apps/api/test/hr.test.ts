import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { parseClock } from '../src/modules/hr';
import { setup, type World } from './helpers';

let w: World;
let openingId: string;
const ids: Record<string, string> = {};
const today = istDate();

const userId = async (role: string) =>
  (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;

beforeAll(async () => {
  w = await setup();
});
afterAll(() => w.close());

describe('HR: who can do what', () => {
  it('keeps applicants and salaries to HR, the owner and admin', async () => {
    const sales = await w.as('sales');
    await sales.get('/api/hr/applicants').expect(403);
    await sales.get('/api/hr/employees').expect(403);
    await sales.get('/api/hr/dashboard').expect(403);
    const accounts = await w.as('accounts');
    await accounts.get('/api/hr/employees').expect(403);
    const owner = await w.as('owner');
    await owner.get('/api/hr/applicants').expect(200);
    await owner.post('/api/hr/openings').send({ title: 'x', department: 'y' }).expect(403);
    const hr = await w.as('hr');
    await hr.get('/api/hr/applicants').expect(200);
    await hr.get('/api/accounting/reports/trial-balance').expect(403);
  });
});

describe('HR: openings and applicants', () => {
  it('opens a position and takes applications against it', async () => {
    const hr = await w.as('hr');
    const opening = await hr.post('/api/hr/openings').send({ title: 'Showroom Sales Executive', department: 'Sales', positions: 2 }).expect(201);
    openingId = opening.body.data.id;
    expect(opening.body.data.status).toBe('open');
    expect(opening.body.data.opened_on).toBe(today);

    const add = (name: string, phone: string, source: string, extra: object = {}) =>
      hr.post('/api/hr/applicants').send({ name, phone, source, opening_id: openingId, ...extra }).expect(201);
    const priya = await add('Priya Nair', '9820011111', 'job_portal', { source_detail: 'Naukri', experience_years: 2.5, expected_salary: 28000, resume_url: 'https://example.com/priya.pdf' });
    const rohan = await add('Rohan Das', '9820022222', 'referral', { source_detail: 'Referred by Asha' });
    const sana = await add('Sana Sheikh', '9820033333', 'walk_in');
    const dev = await add('Dev Patel', '9820044444', 'job_portal');
    Object.assign(ids, { priya: priya.body.data.id, rohan: rohan.body.data.id, sana: sana.body.data.id, dev: dev.body.data.id });

    expect([priya, rohan, sana, dev].map((r) => r.body.data.applicant_no)).toEqual(['A1001', 'A1002', 'A1003', 'A1004']);
    expect(priya.body.data.stage).toBe('applied');
    expect(priya.body.data.phone).toBe('+919820011111');
    expect(priya.body.data.experience_years).toBe('2.5');
    expect(priya.body.data.applied_on).toBe(today);
  });

  it('does not enter the same person twice while their application is open', async () => {
    const hr = await w.as('hr');
    const again = await hr.post('/api/hr/applicants').send({ name: 'Priya N', phone: '+91 98200 11111', source: 'website' }).expect(409);
    expect(again.body.error.message).toContain('A1001');
    expect(again.body.error.details.applicant_id).toBe(ids.priya);
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from applicants`);
    expect(n!.n).toBe(4);
  });

  it('refuses links that are not web links, and a bad phone number', async () => {
    const hr = await w.as('hr');
    await hr.post('/api/hr/applicants').send({ name: 'X', phone: '9820055555', source: 'other', resume_url: 'javascript:alert(1)' }).expect(400);
    await hr.post('/api/hr/applicants').send({ name: 'X', phone: '12345', source: 'other' }).expect(400);
  });

  it('follows the stage machine', async () => {
    const hr = await w.as('hr');
    const stage = (id: string, body: object) => hr.post(`/api/hr/applicants/${id}/stage`).send(body);
    await stage(ids.rohan!, { stage: 'offered' }).expect(409); // cannot jump from Applied to Offered
    await stage(ids.rohan!, { stage: 'hired' }).expect(400); // only through Hire
    await stage(ids.rohan!, { stage: 'applied' }).expect(400); // already there
    await stage(ids.rohan!, { stage: 'rejected' }).expect(400); // needs a reason
    await hr.post(`/api/hr/applicants/${ids.rohan}/hire`).send({ join_date: today, department: 'Sales', designation: 'Executive' }).expect(409);

    const rejected = await stage(ids.rohan!, { stage: 'rejected', reject_reason: 'not_qualified', note: 'No retail experience' }).expect(200);
    expect(rejected.body.data.reject_reason).toBe('not_qualified');
    expect(rejected.body.data.closed_at).toBeTruthy();
    expect(rejected.body.data.qualified_at).toBeNull();
    await stage(ids.rohan!, { stage: 'interview' }).expect(409); // a rejected applicant reopens to Shortlisted only

    const reopened = await stage(ids.rohan!, { stage: 'shortlisted' }).expect(200);
    expect(reopened.body.data.reject_reason).toBeNull();
    expect(reopened.body.data.closed_at).toBeNull();
    expect(reopened.body.data.qualified_at).toBeTruthy();

    const detail = await hr.get(`/api/hr/applicants/${ids.rohan}`).expect(200);
    const notes = detail.body.data.activities.map((a: { note: string }) => a.note);
    expect(notes).toContain('Applied -> Rejected (not qualified): No retail experience');
    expect(notes).toContain('Rejected -> Shortlisted');
  });

  it('the database itself refuses a rejection without a reason and a hire without an employee', async () => {
    await expect(w.db.execute(sql`update applicants set stage = 'rejected' where id = ${ids.sana}`)).rejects.toThrow();
    await expect(w.db.execute(sql`update applicants set stage = 'hired' where id = ${ids.sana}`)).rejects.toThrow();
  });
});

describe('HR: interviews', () => {
  let round1: string;
  let round2: string;

  it('books rounds, moves the applicant to Interview and numbers the rounds', async () => {
    const hr = await w.as('hr');
    const salesUser = await userId('sales');
    const at = new Date(Date.now() + 2 * 86400_000).toISOString();
    const r1 = await hr.post(`/api/hr/applicants/${ids.priya}/interviews`).send({ title: 'Sales manager round', scheduled_at: at, mode: 'in_person', interviewer_id: salesUser }).expect(201);
    const r2 = await hr.post(`/api/hr/applicants/${ids.priya}/interviews`).send({ title: 'HR round', scheduled_at: at, mode: 'video' }).expect(201);
    round1 = r1.body.data.id;
    round2 = r2.body.data.id;
    expect([r1.body.data.round, r2.body.data.round]).toEqual([1, 2]);

    const detail = await hr.get(`/api/hr/applicants/${ids.priya}`).expect(200);
    expect(detail.body.data.stage).toBe('interview');
    expect(detail.body.data.qualified_at).toBeTruthy();
    expect(detail.body.data.interviews).toHaveLength(2);
    expect(detail.body.data.interviews[0].interviewer_name).toBe('sales user');
  });

  it('lets the interviewer, and nobody else outside HR, record the result', async () => {
    const sales = await w.as('sales');
    const mine = await sales.get('/api/hr/interviews/mine').expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].applicant_name).toBe('Priya Nair');
    expect(mine.body.data[0]).not.toHaveProperty('expected_salary');
    await sales.get(`/api/hr/applicants/${ids.priya}`).expect(403); // the interviewer still cannot browse HR

    const store = await w.as('store');
    await store.post(`/api/hr/interviews/${round1}/complete`).send({ result: 'pass' }).expect(403);
    expect((await store.get('/api/hr/interviews/mine').expect(200)).body.data).toHaveLength(0);

    await sales.post(`/api/hr/interviews/${round1}/complete`).send({ result: 'pass', rating: 9 }).expect(400);
    const done = await sales.post(`/api/hr/interviews/${round1}/complete`).send({ result: 'pass', rating: 4, feedback: 'Good with customers' }).expect(200);
    expect(done.body.data.status).toBe('completed');
    await sales.post(`/api/hr/interviews/${round1}/complete`).send({ result: 'fail' }).expect(409);
    expect((await sales.get('/api/hr/interviews/mine').expect(200)).body.data).toHaveLength(0);

    const hr = await w.as('hr');
    await hr.post(`/api/hr/interviews/${round2}/complete`).send({ result: 'pass', rating: 5 }).expect(200);
    const detail = await hr.get(`/api/hr/applicants/${ids.priya}`).expect(200);
    expect(detail.body.data.activities.map((a: { note: string }) => a.note))
      .toContain('Round 1 (Sales manager round): pass, rated 4/5. Good with customers');
  });

  it('cancels the rounds still booked when the applicant is rejected', async () => {
    const hr = await w.as('hr');
    const at = new Date(Date.now() + 86400_000).toISOString();
    const booked = await hr.post(`/api/hr/applicants/${ids.sana}/interviews`).send({ title: 'First round', scheduled_at: at }).expect(201);
    await hr.post(`/api/hr/applicants/${ids.sana}/stage`).send({ stage: 'rejected', reject_reason: 'no_show' }).expect(200);
    const list = await hr.get('/api/hr/interviews?status=cancelled').expect(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(booked.body.data.id);
    await hr.post(`/api/hr/applicants/${ids.sana}/interviews`).send({ title: 'Another', scheduled_at: at }).expect(409);
  });
});

describe('HR: hiring creates the employee', () => {
  it('hires only from Offered, once, and links both records', async () => {
    const hr = await w.as('hr');
    await hr.post(`/api/hr/applicants/${ids.priya}/stage`).send({ stage: 'offered' }).expect(200);
    const hire = { join_date: '2026-01-05', department: 'Sales', designation: 'Showroom Sales Executive', monthly_salary: 28000 };
    const first = await hr.post(`/api/hr/applicants/${ids.priya}/hire`).send(hire).expect(201);
    const employee = first.body.data.employee;
    ids.priyaEmp = employee.id;
    expect(employee.employee_no).toBe('EMP001');
    expect(employee.name).toBe('Priya Nair');
    expect(employee.phone).toBe('+919820011111');
    expect(employee.monthly_salary).toBe('28000.00');
    expect(first.body.data.applicant.stage).toBe('hired');
    expect(first.body.data.applicant.employee_id).toBe(employee.id);

    // Pressing Hire again gives back the same employee instead of a second one.
    const second = await hr.post(`/api/hr/applicants/${ids.priya}/hire`).send(hire).expect(201);
    expect(second.body.data.employee.id).toBe(employee.id);
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from employees`);
    expect(n!.n).toBe(1);

    await hr.post(`/api/hr/applicants/${ids.priya}/stage`).send({ stage: 'rejected', reject_reason: 'other' }).expect(409);
    const page = await hr.get(`/api/hr/employees/${employee.id}`).expect(200);
    expect(page.body.data.applicant_no).toBe('A1001');
  });

  it('will not put the same person on the rolls twice', async () => {
    const dup = await (await w.as('admin')).post('/api/hr/employees').send({ name: 'Priya again', phone: '9820011111', department: 'Sales', designation: 'x', join_date: today }).expect(409);
    expect(dup.body.error.message).toContain('EMP001');
  });

  it('closing an opening needs a decision on everyone still in progress', async () => {
    const hr = await w.as('hr');
    const blocked = await hr.patch(`/api/hr/openings/${openingId}`).send({ status: 'closed' }).expect(409);
    expect(blocked.body.error.details.in_progress).toBe(2); // Rohan (shortlisted) and Dev (applied)
    const closed = await hr.patch(`/api/hr/openings/${openingId}`).send({ status: 'closed', reject_open: true }).expect(200);
    expect(closed.body.data.status).toBe('closed');
    expect(closed.body.data.closed_on).toBe(today);

    const list = await hr.get('/api/hr/openings').expect(200);
    expect(list.body.data[0]).toMatchObject({ applicants: 4, in_progress: 0, hired: 1, positions: 2 });
    const dev = await hr.get(`/api/hr/applicants/${ids.dev}`).expect(200);
    expect(dev.body.data).toMatchObject({ stage: 'rejected', reject_reason: 'position_filled' });

    await hr.post('/api/hr/applicants').send({ name: 'Late', phone: '9820066666', source: 'website', opening_id: openingId }).expect(409);
    // Without an opening it is a general application, and Rohan can apply again now that his first one is closed.
    const general = await hr.post('/api/hr/applicants').send({ name: 'Rohan Das', phone: '9820022222', source: 'website' }).expect(201);
    expect(general.body.data.applicant_no).toBe('A1005');
    const page = await hr.get(`/api/hr/applicants/${general.body.data.id}`).expect(200);
    expect(page.body.data.earlier_applications.map((a: { applicant_no: string }) => a.applicant_no)).toEqual(['A1002']);
  });
});

describe('HR: employees', () => {
  it('adds existing staff, edits one field without touching the rest, and links a sign-in once', async () => {
    const arjun = await (await w.as('admin')).post('/api/hr/employees').send({
      name: 'Arjun Mehta', phone: '9833000001', department: 'Stores', designation: 'Stores Assistant', join_date: '2026-01-01', monthly_salary: 22000,
    }).expect(201);
    ids.arjun = arjun.body.data.id;
    expect(arjun.body.data.employee_no).toBe('EMP002');
    expect(arjun.body.data.employment_type).toBe('full_time');

    await (await w.as('admin')).patch(`/api/hr/employees/${ids.arjun}`).send({ employment_type: 'contract' }).expect(200);
    const patched = await (await w.as('admin')).patch(`/api/hr/employees/${ids.arjun}`).send({ designation: 'Stores Supervisor' }).expect(200);
    expect(patched.body.data).toMatchObject({
      designation: 'Stores Supervisor', department: 'Stores', monthly_salary: '22000.00', employment_type: 'contract', phone: '+919833000001',
    });

    const storesUser = await userId('stores');
    await (await w.as('admin')).patch(`/api/hr/employees/${ids.arjun}`).send({ user_id: storesUser }).expect(200);
    const clash = await (await w.as('admin')).patch(`/api/hr/employees/${ids.priyaEmp}`).send({ user_id: storesUser }).expect(409);
    expect(clash.body.error.message).toContain('Arjun Mehta');
  });
});

describe('HR: attendance', () => {
  const mark = async (date: string, entries: object[], status: number) =>
    (await w.as('hr')).put('/api/hr/attendance').send({ date, entries }).expect(status);

  it('marks a day, and marking it again corrects it instead of doubling it', async () => {
    const hr = await w.as('hr');
    const register = await hr.get('/api/hr/attendance?date=2026-01-06').expect(200);
    expect(register.body.data.map((e: { name: string }) => e.name)).toEqual(['Priya Nair', 'Arjun Mehta']); // by department, then name
    expect(register.body.data.every((e: { status: unknown }) => e.status === null)).toBe(true);

    await mark('2026-01-06', [
      { employee_id: ids.priyaEmp, status: 'present', check_in: '09:30', check_out: '18:15' },
      { employee_id: ids.arjun, status: 'absent' },
    ], 200);
    await mark('2026-01-06', [{ employee_id: ids.arjun, status: 'half_day', check_in: '09:30', note: 'Left at lunch' }], 200);

    const after = await hr.get('/api/hr/attendance?date=2026-01-06').expect(200);
    expect(after.body.data.find((e: { employee_id: string }) => e.employee_id === ids.arjun)).toMatchObject({ status: 'half_day', check_in: '09:30', check_out: null, note: 'Left at lunch' });
    expect(after.body.data.find((e: { employee_id: string }) => e.employee_id === ids.priyaEmp)).toMatchObject({ status: 'present', check_in: '09:30', check_out: '18:15' });
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from attendance`);
    expect(n!.n).toBe(2);
  });

  it('refuses days that make no sense', async () => {
    await mark(addDays(today, 1), [{ employee_id: ids.arjun, status: 'present' }], 400); // tomorrow
    await mark('2026-01-02', [{ employee_id: ids.priyaEmp, status: 'present' }], 400); // before she joined
    await mark('2026-01-07', [{ employee_id: ids.arjun, status: 'leave', check_in: '09:00' }], 400); // times on a day off
    await mark('2026-01-07', [{ employee_id: ids.arjun, status: 'present', check_in: '18:00', check_out: '09:00' }], 400);
    await mark('2026-01-07', [{ employee_id: ids.arjun, status: 'present' }, { employee_id: ids.arjun, status: 'absent' }], 400);
    await mark('2026-01-07', [{ employee_id: ids.arjun, status: 'sleeping' }], 400);
    const sales = await w.as('sales');
    await sales.put('/api/hr/attendance').send({ date: '2026-01-07', entries: [{ employee_id: ids.arjun, status: 'present' }] }).expect(403);
  });

  it('imports a month from the attendance app, all or nothing', async () => {
    const hr = await w.as('hr');
    const good = [
      'Emp Code,Employee Name,Date,Status,In Time,Out Time',
      'EMP002,Arjun Mehta,07/01/2026,P,9:30 AM,6:15 PM',
      'emp002,Arjun Mehta,08-Jan-2026,HD,09:30,13:00',
      'EMP002,Arjun Mehta,09/01/2026,A,,',
      'EMP002,Arjun Mehta,10/01/2026,Leave,-,-',
      'EMP002,Arjun Mehta,11/01/2026,WO,,',
      '98200 11111,Priya Nair,07/01/2026,Present,10:00,18:30',
    ].join('\n');
    const bad = `${good}\nEMP099,Nobody,07/01/2026,P,,\nEMP002,Arjun Mehta,32/01/2026,P,,\nEMP002,Arjun Mehta,12/01/2026,Dancing,,`;
    const refused = await hr.post('/api/hr/attendance/import').send({ csv: bad }).expect(400);
    expect(refused.body.error.details.errors.map((e: { row: number }) => e.row)).toEqual([8, 9, 10]);
    const [before] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from attendance`);
    expect(before!.n).toBe(2);

    const done = await hr.post('/api/hr/attendance/import').send({ csv: good }).expect(201);
    expect(done.body.data).toMatchObject({ rows_in_file: 6, saved: 6, days: 5, from: '2026-01-07', to: '2026-01-11' });
    await hr.post('/api/hr/attendance/import').send({ csv: good }).expect(201); // the same file again changes nothing
    const [after] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from attendance`);
    expect(after!.n).toBe(8);

    const day = await hr.get('/api/hr/attendance?date=2026-01-07').expect(200);
    expect(day.body.data.find((e: { employee_id: string }) => e.employee_id === ids.arjun)).toMatchObject({ status: 'present', check_in: '09:30', check_out: '18:15' });
    await hr.post('/api/hr/attendance/import').send({ csv: 'Name,Day\nArjun,Monday' }).expect(400);
  });

  it('reads the clock times an export may contain', () => {
    expect(parseClock('9:30 AM')).toBe('09:30');
    expect(parseClock('12:05 am')).toBe('00:05');
    expect(parseClock('12:00 PM')).toBe('12:00');
    expect(parseClock('6.15 pm')).toBe('18:15');
    expect(parseClock('18:15:40')).toBe('18:15');
    expect(parseClock('')).toBeNull();
    expect(parseClock('-')).toBeNull();
    expect(parseClock('25:00')).toBeUndefined();
    expect(parseClock('noon')).toBeUndefined();
  });

  it('adds the month up for each employee', async () => {
    const hr = await w.as('hr');
    const summary = await hr.get('/api/hr/attendance/summary?month=2026-01').expect(200);
    const of = (id: string) => summary.body.data.find((e: { employee_id: string }) => e.employee_id === id);
    // Arjun joined on the 1st: half day on the 6th, present 7th, half day 8th, absent 9th, leave 10th, weekly off 11th.
    expect(of(ids.arjun!)).toMatchObject({ present: 1, half_day: 2, absent: 1, leave: 1, weekly_off: 1, holiday: 0, days_worked: '2.0', not_marked: 25 });
    // Priya joined on the 5th (27 days left in January): present on the 6th and 7th.
    expect(of(ids.priyaEmp!)).toMatchObject({ present: 2, half_day: 0, days_worked: '2.0', not_marked: 25 });
    const csv = await hr.get('/api/hr/attendance/summary?month=2026-01&format=csv').expect(200);
    expect(csv.text).toContain('days_worked');
  });

  it('records an exit, after which the person is off the register', async () => {
    const hr = await w.as('hr');
    await hr.post(`/api/hr/employees/${ids.arjun}/exit`).send({ left_on: '2026-01-08' }).expect(409); // attendance exists after the 8th
    await hr.post(`/api/hr/employees/${ids.arjun}/exit`).send({ left_on: addDays(today, 3) }).expect(400);
    const left = await hr.post(`/api/hr/employees/${ids.arjun}/exit`).send({ left_on: '2026-01-20', reason: 'Moved cities' }).expect(200);
    expect(left.body.data).toMatchObject({ status: 'left', left_on: '2026-01-20' });
    expect(left.body.sign_in_still_active).toBe(true); // HR cannot switch sign-ins off; the screen tells them to ask an admin
    await hr.post(`/api/hr/employees/${ids.arjun}/exit`).send({ left_on: '2026-01-21' }).expect(409);

    await mark('2026-01-21', [{ employee_id: ids.arjun, status: 'present' }], 400);
    const register = await hr.get('/api/hr/attendance?date=2026-01-21').expect(200);
    expect(register.body.data.map((e: { name: string }) => e.name)).toEqual(['Priya Nair']);
    const summary = await hr.get('/api/hr/attendance/summary?month=2026-01').expect(200);
    expect(summary.body.data.find((e: { employee_id: string }) => e.employee_id === ids.arjun).not_marked).toBe(14); // 20 days on the rolls, 6 marked
    const february = await hr.get('/api/hr/attendance/summary?month=2026-02').expect(200);
    expect(february.body.data.map((e: { name: string }) => e.name)).toEqual(['Priya Nair']);

    // Someone who left can be taken on again as a new record.
    const back = await (await w.as('admin')).post('/api/hr/employees').send({ name: 'Arjun Mehta', phone: '9833000001', department: 'Stores', designation: 'Stores Assistant', join_date: today }).expect(201);
    expect(back.body.data.employee_no).toBe('EMP003');
  });
});

describe('HR: dashboard', () => {
  it('counts resumes in, qualified, rejected and hired, and shows who is where', async () => {
    const owner = await w.as('owner');
    const res = await owner.get('/api/hr/dashboard').expect(200);
    const d = res.body.data;
    // Five applications today: Priya hired; Rohan (shortlisted once) and Dev (never) rejected when the opening closed;
    // Sana rejected after an interview was booked; Rohan's new general application still open.
    expect(d.totals).toMatchObject({ received: 5, qualified: 3, rejected: 3, rejected_at_screening: 1, hired: 1, in_progress: 1 });
    expect(d.pipeline).toEqual([{ stage: 'applied', count: 1 }]);
    expect(d.by_source.find((s: { source: string }) => s.source === 'job_portal')).toMatchObject({ applicants: 2, hired: 1 });
    expect(d.rejections).toEqual(expect.arrayContaining([{ reason: 'position_filled', count: 2 }, { reason: 'no_show', count: 1 }]));
    expect(d.hiring.hired).toBe(1);
    expect(d.applicants_by_day).toEqual([{ day: today, applicants: 5 }]);
    expect(d.openings).toEqual([]);
    expect(d.headcount).toEqual(expect.arrayContaining([{ department: 'Sales', count: 1 }, { department: 'Stores', count: 1 }]));
    expect(d.attendance_today).toMatchObject({ on_rolls: 2, present: 0, not_marked: 2 });
  });
});

describe('HR: leave balances', () => {
  it('works out what each person is entitled to, has taken and has left in a leave year', async () => {
    const hr = await w.as('hr');
    await (await w.as('sales')).get('/api/hr/leave-balances').expect(403);
    await (await w.as('owner')).put('/api/hr/leave-policy').send({ annual_leave_days: 20 }).expect(403);

    // January 2026 falls in the leave year 2025-26. Both joined that January, so they get January to March: 3 of the 12 days.
    let res = (await hr.get('/api/hr/leave-balances?fy=2025-26').expect(200)).body;
    expect(res).toMatchObject({ fy: '2025-26', from: '2025-04-01', to: '2026-03-31', annual_leave_days: 12 });
    const of = (id: string) => res.data.find((e: { employee_id: string }) => e.employee_id === id);
    expect(res.data).toHaveLength(2); // the Arjun who rejoined today is not part of that year
    expect(of(ids.priyaEmp!)).toMatchObject({ entitled: 3, taken: 0, balance: 3, own_rule: false });
    expect(of(ids.arjun!)).toMatchObject({ entitled: 3, taken: 1, balance: 2 }); // one day of leave on the 10th

    // A person can have their own figure; the company's figure covers everyone else.
    await (await w.as('admin')).patch(`/api/hr/employees/${ids.priyaEmp}`).send({ annual_leave_days: 18 }).expect(200);
    await hr.put('/api/hr/leave-policy').send({ annual_leave_days: 15 }).expect(200);
    res = (await hr.get('/api/hr/leave-balances?fy=2025-26').expect(200)).body;
    expect(of(ids.priyaEmp!)).toMatchObject({ entitled: 4.5, own_rule: true });
    expect(of(ids.arjun!)).toMatchObject({ entitled: 4, balance: 3 }); // 15 x 3/12 = 3.75, to the nearest half

    // This year: Priya has been here throughout, so she gets her full 18.
    res = (await hr.get('/api/hr/leave-balances').expect(200)).body;
    expect(of(ids.priyaEmp!)).toMatchObject({ entitled: 18, taken: 0, balance: 18 });
    await (await w.as('admin')).patch(`/api/hr/employees/${ids.priyaEmp}`).send({ annual_leave_days: '' }).expect(200); // back to the company's figure
    res = (await hr.get('/api/hr/leave-balances').expect(200)).body;
    expect(of(ids.priyaEmp!)).toMatchObject({ entitled: 15, own_rule: false });
  });
});
