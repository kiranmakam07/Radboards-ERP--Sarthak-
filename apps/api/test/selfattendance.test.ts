import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, distanceMetres, istDate, weekdayOf, workingDates } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

let w: World;
const today = istDate();
const id: Record<string, string> = {};

// The showroom, and a spot about 150 m north of it and one about 5 km away.
const OFFICE = { lat: 18.5204, lng: 73.8567 };
const NEARBY = { lat: 18.52175, lng: 73.8567 };
const FAR = { lat: 18.5654, lng: 73.8567 };

const dayRow = async (employeeId: string, date = today) =>
  (await rows<Record<string, any>>(w.db, sql`select * from attendance where employee_id = ${employeeId} and date = ${date}::date`))[0] as Record<string, any>;
/** The next date on or after `from` that falls on the given weekday (0 = Sunday). */
const next = (weekday: number, from: string) => {
  let d = from;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
};

beforeAll(async () => {
  w = await setup();
  const user = async (role: string) => (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;
  const employee = async (name: string, phone: string, role: string | null) =>
    (await (await w.as('admin')).post('/api/hr/employees').send({
      name, phone, department: 'Sales', designation: 'Executive', join_date: addDays(today, -400), user_id: role ? await user(role) : '',
    }).expect(201)).body.data.id as string;
  id.sales = await employee('Amit Verma', '9822200001', 'sales');
  id.store = await employee('Sunita Rao', '9822200002', 'store');
  id.nologin = await employee('Ganesh Pawar', '9822200003', null);
});
afterAll(async () => {
  await w.close();
});

describe('distance and working days', () => {
  it('measures how far a phone is from the workplace', () => {
    expect(Math.round(distanceMetres(OFFICE, OFFICE))).toBe(0);
    expect(distanceMetres(OFFICE, NEARBY)).toBeGreaterThan(140);
    expect(distanceMetres(OFFICE, NEARBY)).toBeLessThan(160);
    expect(Math.round(distanceMetres(OFFICE, FAR) / 100)).toBe(50);
  });

  it('counts the days of a span, leaving out the weekly off', () => {
    const monday = next(1, '2026-10-12');
    expect(workingDates(monday, addDays(monday, 6), [0])).toHaveLength(6);
    expect(workingDates(monday, addDays(monday, 6), [0, 6])).toHaveLength(5);
    expect(workingDates(monday, addDays(monday, 6))).toHaveLength(7);
    expect(workingDates(addDays(monday, 6), addDays(monday, 6), [0])).toEqual([]);
  });
});

describe('clocking in and out from the phone', () => {
  it('is only for someone with an employee record behind their sign-in', async () => {
    const accounts = await w.as('accounts');
    expect((await accounts.get('/api/hr/me').expect(200)).body.data).toBeNull();
    const res = await accounts.post('/api/hr/me/clock-in').send({}).expect(404);
    expect(res.body.error.message).toMatch(/not linked to an employee record/);
  });

  it('marks the day as worked with the time, and notes how far from the workplace it was done', async () => {
    const hr = await w.as('hr');
    await hr.put('/api/hr/attendance-rules').send({ start: '10:00', grace_min: 10, weekly_off: [0], place: { name: 'Showroom', ...OFFICE, radius_m: 200 } }).expect(200);

    const sales = await w.as('sales');
    const before = (await sales.get('/api/hr/me').expect(200)).body.data;
    expect(before).toMatchObject({ employee: { name: 'Amit Verma' }, today, today_row: null, place: { name: 'Showroom', radius_m: 200 }, leave: { entitled: 12, taken: 0, left: 12 } });

    await sales.post('/api/hr/me/clock-in').send({ at: NEARBY }).expect(201);
    const row = await dayRow(id.sales!);
    expect(row).toMatchObject({ status: 'present', self_marked: true, check_out: null });
    expect(row.check_in).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row.in_distance_m).toBeGreaterThan(140);
    expect(row.in_distance_m).toBeLessThan(160);
    expect(Number(row.in_lat)).toBeCloseTo(NEARBY.lat, 5);

    // A second tap does not clock in twice or move the time.
    expect((await sales.post('/api/hr/me/clock-in').send({ at: FAR }).expect(409)).body.error.message).toMatch(/already clocked in today at \d{2}:\d{2}/);
    expect((await dayRow(id.sales!)).check_in).toBe(row.check_in);
  });

  it('clocks out once, after clocking in', async () => {
    const store = await w.as('store');
    expect((await store.post('/api/hr/me/clock-out').send({}).expect(409)).body.error.message).toBe('You have not clocked in today');

    // The clock-in is put a few hours back, as if the morning had passed.
    await rows(w.db, sql`update attendance set check_in = '00:00:01' where employee_id = ${id.sales} and date = ${today}::date`);
    const sales = await w.as('sales');
    await sales.post('/api/hr/me/clock-out').send({ at: FAR }).expect(200);
    const row = await dayRow(id.sales!);
    expect(row.check_out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row.out_distance_m).toBeGreaterThan(4900);
    expect((await sales.post('/api/hr/me/clock-out').send({}).expect(409)).body.error.message).toMatch(/already clocked out today/);

    const mine = (await sales.get('/api/hr/me').expect(200)).body.data;
    expect(mine.today_row).toMatchObject({ status: 'present', self_marked: true });
    expect(mine.today_row.out_distance_m).toBeGreaterThan(4900);
  });

  it('still clocks in when the phone gives no location, and says so on the register', async () => {
    const store = await w.as('store');
    await store.post('/api/hr/me/clock-in').send({}).expect(201);
    await store.post('/api/hr/me/clock-in').send({ at: { lat: 123, lng: 0 } }).expect(400);
    const register = (await (await w.as('hr')).get('/api/hr/attendance').expect(200)).body;
    const of = (name: string) => register.data.find((e: any) => e.name === name);
    expect(of('Sunita Rao')).toMatchObject({ status: 'present', self_marked: true, no_location: true, in_distance_m: null });
    expect(of('Amit Verma')).toMatchObject({ status: 'present', self_marked: true, no_location: false, late: false });
    expect(of('Ganesh Pawar')).toMatchObject({ status: null, self_marked: false });
    expect(register.rules).toMatchObject({ start: '10:00', grace_min: 10 });
  });

  it('leaves a day HR marked absent as HR marked it: the person asks HR, who changes it (technical review, 26 Oct 2026)', async () => {
    const hr = await w.as('hr');
    const admin = await w.as('admin');
    const [storesUser] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'stores'`);
    const ravi = (await admin.post('/api/hr/employees').send({ name: 'Ravi Stores', phone: '9822200019', department: 'Stores', designation: 'Storekeeper', join_date: addDays(today, -30), user_id: storesUser!.id }).expect(201)).body.data.id;
    await hr.put('/api/hr/attendance').send({ date: today, entries: [{ employee_id: ravi, status: 'absent' }] }).expect(200);
    const stores = await w.as('stores');
    const refused = await stores.post('/api/hr/me/clock-in').send({ at: OFFICE }).expect(409);
    expect(refused.body.error.message).toMatch(/HR has marked today as absent for you/);
    expect(await dayRow(ravi)).toMatchObject({ status: 'absent', self_marked: false });
    // HR puts it right; the clock-in then records the times.
    await hr.put('/api/hr/attendance').send({ date: today, entries: [{ employee_id: ravi, status: 'present' }] }).expect(200);
    await stores.post('/api/hr/me/clock-in').send({ at: OFFICE }).expect(201);
    expect(await dayRow(ravi)).toMatchObject({ status: 'present', self_marked: true, in_distance_m: 0 });
  });

  it('does not let HR mark their own attendance or decide their own leave', async () => {
    const hr = await w.as('hr');
    const [hrUser] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'hr'`);
    const priya = (await (await w.as('admin')).post('/api/hr/employees').send({ name: 'Priya HR', phone: '9822200009', department: 'HR', designation: 'HR', join_date: addDays(today, -30), user_id: hrUser!.id }).expect(201)).body.data.id;
    const own = await hr.put('/api/hr/attendance').send({ date: today, entries: [{ employee_id: priya, status: 'present' }] }).expect(403);
    expect(own.body.error.message).toMatch(/Someone else marks your own attendance/);
    await hr.post('/api/hr/me/clock-in').send({ at: OFFICE }).expect(201);
    expect(await dayRow(priya)).toMatchObject({ status: 'present', self_marked: true });
  });

  it('counts late arrivals and hours worked in the month', async () => {
    // Amit came in at 10:25 and left at 18:55 today: late by the rule (10:00 + 10 minutes), 8.5 hours.
    await rows(w.db, sql`update attendance set check_in = '10:25:00', check_out = '18:55:00' where employee_id = ${id.sales} and date = ${today}::date`);
    const hr = await w.as('hr');
    const summary = (await hr.get('/api/hr/attendance/summary').expect(200)).body.data;
    expect(summary.find((e: any) => e.name === 'Amit Verma')).toMatchObject({ present: 1, late_days: 1, hours_worked: '8.5' });
    expect((await hr.get('/api/hr/attendance').expect(200)).body.data.find((e: any) => e.name === 'Amit Verma').late).toBe(true);
    // Within the grace period is not late; with no start time set, nobody is.
    await rows(w.db, sql`update attendance set check_in = '10:10:00' where employee_id = ${id.sales} and date = ${today}::date`);
    expect((await hr.get('/api/hr/attendance/summary').expect(200)).body.data.find((e: any) => e.name === 'Amit Verma').late_days).toBe(0);
    await rows(w.db, sql`update attendance set check_in = '11:30:00' where employee_id = ${id.sales} and date = ${today}::date`);
    await hr.put('/api/hr/attendance-rules').send({ start: '', grace_min: 10, weekly_off: [0], place: null }).expect(200);
    expect((await hr.get('/api/hr/attendance/summary').expect(200)).body.data.find((e: any) => e.name === 'Amit Verma').late_days).toBe(0);
    await (await w.as('sales')).put('/api/hr/attendance-rules').send({ start: '09:00', grace_min: 0, weekly_off: [], place: null }).expect(403);
  });
});

describe('asking for leave', () => {
  const monday = next(1, addDays(today, 7));
  let requestId: string;

  it('takes a request for working days only, and refuses one that makes no sense', async () => {
    const sales = await w.as('sales');
    // Friday to the Monday after: Sunday is the weekly off, so that is three days of leave, not four.
    const friday = addDays(monday, 4);
    const made = await sales.post('/api/hr/me/leave').send({ from: friday, to: addDays(friday, 3), reason: 'Sister’s wedding' }).expect(201);
    requestId = made.body.data.id;
    expect(made.body.data).toMatchObject({ status: 'pending', days: 3, from_date: friday });

    await sales.post('/api/hr/me/leave').send({ from: addDays(friday, 3), to: addDays(friday, 5), reason: 'More' }).expect(409); // overlaps the one above
    await sales.post('/api/hr/me/leave').send({ from: addDays(monday, 2), to: addDays(monday, 1), reason: 'Backwards' }).expect(400);
    await sales.post('/api/hr/me/leave').send({ from: addDays(monday, 6), to: addDays(monday, 6), reason: 'A Sunday' }).expect(400);
    await sales.post('/api/hr/me/leave').send({ from: addDays(today, -45), to: addDays(today, -44), reason: 'Long ago' }).expect(400);
    await sales.post('/api/hr/me/leave').send({ from: monday, to: addDays(monday, 70), reason: 'Sabbatical' }).expect(400);
    await sales.post('/api/hr/me/leave').send({ from: monday, to: monday, reason: '' }).expect(400);
    await (await w.as('accounts')).post('/api/hr/me/leave').send({ from: monday, to: monday, reason: 'No record' }).expect(404);
  });

  it('goes into the register as Leave when HR approves it, and comes off the balance', async () => {
    const hr = await w.as('hr');
    const pending = (await hr.get('/api/hr/leave-requests?status=pending').expect(200)).body.data;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: 'Amit Verma', days: 3, reason: 'Sister’s wedding', taken_this_year: 0 });
    await (await w.as('sales')).post(`/api/hr/leave-requests/${requestId}/decide`).send({ approve: true }).expect(403); // nobody approves their own
    await hr.post(`/api/hr/leave-requests/${requestId}/decide`).send({ approve: true, note: 'Enjoy' }).expect(200);
    await hr.post(`/api/hr/leave-requests/${requestId}/decide`).send({ approve: true }).expect(409);

    const friday = addDays(monday, 4);
    const marked = await rows<{ date: string; status: string; note: string }>(w.db, sql`
      select date::text, status::text, note from attendance where employee_id = ${id.sales} and date > ${today}::date order by date`);
    expect(marked.map((m) => [m.date, m.status])).toEqual([[friday, 'leave'], [addDays(friday, 1), 'leave'], [addDays(friday, 3), 'leave']]); // no Sunday
    expect(marked[0]!.note).toBe('Leave approved: Sister’s wedding');

    const mine = (await (await w.as('sales')).get('/api/hr/me').expect(200)).body.data;
    expect(mine.leave).toEqual({ entitled: 12, taken: 3, left: 9 });
    expect(mine.requests[0]).toMatchObject({ status: 'approved', decision_note: 'Enjoy', decided_by: 'hr user' });
  });

  it('can be refused with a reason, or taken back before anyone decides', async () => {
    const store = await w.as('store');
    const hr = await w.as('hr');
    const a = (await store.post('/api/hr/me/leave').send({ from: monday, to: addDays(monday, 1), reason: 'Trip' }).expect(201)).body.data.id;
    await hr.post(`/api/hr/leave-requests/${a}/decide`).send({ approve: false }).expect(400); // a refusal needs its reason
    await hr.post(`/api/hr/leave-requests/${a}/decide`).send({ approve: false, note: 'Stock take that week' }).expect(200);
    expect(await rows(w.db, sql`select 1 from attendance where employee_id = ${id.store} and date > ${today}::date`)).toHaveLength(0);

    // The same days can be asked for again once the first request is out of the way.
    const b = (await store.post('/api/hr/me/leave').send({ from: monday, to: monday, reason: 'One day then' }).expect(201)).body.data.id;
    await (await w.as('sales')).post(`/api/hr/me/leave/${b}/cancel`).send({}).expect(404); // not theirs
    await store.post(`/api/hr/me/leave/${b}/cancel`).send({}).expect(200);
    await store.post(`/api/hr/me/leave/${b}/cancel`).send({}).expect(409);
    await hr.post(`/api/hr/leave-requests/${b}/decide`).send({ approve: true }).expect(409);
    expect((await store.get('/api/hr/me').expect(200)).body.data.requests.map((r: any) => r.status)).toEqual(['cancelled', 'rejected']);
  });

  it('leaves a day already worked alone, and turns an absent day into leave', async () => {
    const hr = await w.as('hr');
    const store = await w.as('store');
    const yesterday = addDays(today, -1);
    const dayBefore = addDays(today, -2);
    // Sunita was marked absent two days ago and present yesterday; she now asks for leave covering both.
    await hr.put('/api/hr/attendance').send({ date: dayBefore, entries: [{ employee_id: id.store, status: 'absent' }] }).expect(200);
    await hr.put('/api/hr/attendance').send({ date: yesterday, entries: [{ employee_id: id.store, status: 'present', check_in: '10:00', check_out: '18:00' }] }).expect(200);
    const off = [weekdayOf(dayBefore), weekdayOf(yesterday)].includes(0);
    const req = (await store.post('/api/hr/me/leave').send({ from: dayBefore, to: yesterday, reason: 'Was unwell' }).expect(201)).body.data;
    await hr.post(`/api/hr/leave-requests/${req.id}/decide`).send({ approve: true }).expect(200);
    expect((await dayRow(id.store!, yesterday)).status).toBe('present');
    if (!off) expect((await dayRow(id.store!, dayBefore)).status).toBe('leave');
  });
});
