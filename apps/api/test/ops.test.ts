import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, istDate, weekdayOf } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { ensureTasks } from '../src/modules/ops';
import { setup, type World } from './helpers';

const today = istDate();
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

const userIdOf = async (w: World, role: string) =>
  (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;
const taskCount = async (w: World, where = sql`true`) =>
  (await rows<{ n: number }>(w.db, sql`select count(*)::int as n from tasks where ${where}`))[0]!.n;

describe('operations: tasks, assets and maintenance', () => {
  let w: World;
  const u: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    w = await setup();
    for (const role of ['store', 'sales', 'stores', 'accounts', 'operations']) u[role] = await userIdOf(w, role);
  });
  afterAll(() => w.close());

  const myTasks = async (role: 'store' | 'sales' | 'stores' | 'accounts' | 'operations') =>
    (await (await w.as(role)).get('/api/ops/my-tasks').expect(200)).body.data;

  it('lets everyone see their own tasks, and only operations run the board', async () => {
    const sales = await w.as('sales');
    await sales.get('/api/ops/tasks').expect(403);
    await sales.get('/api/ops/assets').expect(403);
    await sales.post('/api/ops/templates').send({}).expect(403);
    expect((await myTasks('sales')).tasks).toEqual([]);
    const owner = await w.as('owner');
    await owner.get('/api/ops/tasks').expect(200);
    await owner.post('/api/ops/templates').send({ title: 'x', frequency: 'daily', assignee_id: u.store }).expect(403);
  });

  it('sets up recurring tasks with a checklist, and today\'s task is there straight away', async () => {
    const ops = await w.as('operations');
    const daily = await ops.post('/api/ops/templates').send({
      title: 'Open the showroom', frequency: 'daily', weekdays: ALL_WEEK, assignee_id: u.store,
      checklist: ['Lights and display screens on', 'Count the cash float'],
    }).expect(201);
    ids.daily = daily.body.data.id;
    expect(daily.body.data.weekdays).toEqual(ALL_WEEK);

    // A weekly task on a day that is not today, and a need-based one: neither creates anything yet.
    const otherDay = (weekdayOf(today) + 3) % 7;
    const weekly = await ops.post('/api/ops/templates').send({ title: 'Stock count of fast movers', frequency: 'weekly', weekdays: [otherDay], assignee_id: u.stores }).expect(201);
    expect(weekly.body.data.weekdays).toEqual([otherDay]);
    const need = await ops.post('/api/ops/templates').send({ title: 'Receive a container', frequency: 'need_based', assignee_id: u.stores, checklist: ['Check seal number'] }).expect(201);
    ids.need = need.body.data.id;
    const plainDaily = await ops.post('/api/ops/templates').send({ title: 'Lock up', frequency: 'daily', assignee_id: u.store, start_date: addDays(today, 30) }).expect(201);
    expect(plainDaily.body.data.weekdays).toEqual([1, 2, 3, 4, 5, 6]); // Monday to Saturday unless told otherwise

    await ops.post('/api/ops/templates').send({ title: 'x', frequency: 'weekly', assignee_id: u.store }).expect(400);
    await ops.post('/api/ops/templates').send({ title: 'x', frequency: 'monthly', assignee_id: u.store }).expect(400);
    await ops.post('/api/ops/templates').send({ title: 'x', frequency: 'weekly', weekdays: [9], assignee_id: u.store }).expect(400);
    await ops.post('/api/ops/templates').send({ title: 'x', frequency: 'yearly', assignee_id: u.store }).expect(400);

    const mine = await myTasks('store');
    expect(mine.tasks).toHaveLength(1);
    expect(mine.tasks[0]).toMatchObject({ title: 'Open the showroom', due_date: today, status: 'open', overdue: false, checklist_total: 2, checklist_done: 0, frequency: 'daily' });
    ids.task = mine.tasks[0].id;
    expect((await myTasks('stores')).tasks).toEqual([]);

    // Opening the screens again and again creates nothing new.
    await ops.get('/api/ops/tasks').expect(200);
    await myTasks('store');
    expect(await taskCount(w)).toBe(1);
  });

  it('is worked by the person it is given to: tick the checklist, then finish', async () => {
    const store = await w.as('store');
    const sales = await w.as('sales');
    await sales.get(`/api/ops/tasks/${ids.task}`).expect(403);
    await sales.post(`/api/ops/tasks/${ids.task}/checklist`).send({ index: 0, done: true }).expect(403);
    await sales.post(`/api/ops/tasks/${ids.task}/complete`).send({}).expect(403);

    const early = await store.post(`/api/ops/tasks/${ids.task}/complete`).send({}).expect(409);
    expect(early.body.error.message).toContain('2 checklist item(s)');
    await store.post(`/api/ops/tasks/${ids.task}/checklist`).send({ index: 5, done: true }).expect(400);
    await store.post(`/api/ops/tasks/${ids.task}/checklist`).send({ index: 0, done: true }).expect(200);
    const ticked = await store.post(`/api/ops/tasks/${ids.task}/checklist`).send({ index: 1, done: true }).expect(200);
    expect(ticked.body.data.checklist).toEqual([
      { text: 'Lights and display screens on', done: true }, { text: 'Count the cash float', done: true },
    ]);
    const done = await store.post(`/api/ops/tasks/${ids.task}/complete`).send({ note: 'Float was 2,000' }).expect(200);
    expect(done.body.data).toMatchObject({ status: 'done', note: 'Float was 2,000' });
    expect(done.body.data.completed_at).toBeTruthy();
    await store.post(`/api/ops/tasks/${ids.task}/complete`).send({}).expect(409);
    await store.post(`/api/ops/tasks/${ids.task}/checklist`).send({ index: 0, done: false }).expect(409);

    // Finished today: still on my list, shown as done.
    const mine = await myTasks('store');
    expect(mine.tasks.map((t: { status: string }) => t.status)).toEqual(['done']);
  });

  it('raises need-based tasks by hand, and skipping one needs a reason', async () => {
    const ops = await w.as('operations');
    const stores = await w.as('stores');
    const first = await ops.post(`/api/ops/templates/${ids.need}/raise`).send({}).expect(201);
    const second = await ops.post(`/api/ops/templates/${ids.need}/raise`).send({ due_date: addDays(today, 2) }).expect(201);
    await ops.post(`/api/ops/templates/${ids.need}/raise`).send({ due_date: addDays(today, -1) }).expect(400);
    expect(first.body.data).toMatchObject({ due_date: today, assignee_id: u.stores, scheduled_for: null });
    expect((await myTasks('stores')).tasks.map((t: { id: string }) => t.id)).toEqual([first.body.data.id, second.body.data.id]);

    await stores.post(`/api/ops/tasks/${first.body.data.id}/skip`).send({}).expect(400);
    const skipped = await stores.post(`/api/ops/tasks/${first.body.data.id}/skip`).send({ reason: 'Container delayed at port' }).expect(200);
    expect(skipped.body.data).toMatchObject({ status: 'skipped', note: 'Container delayed at port' });
    await stores.post(`/api/ops/tasks/${first.body.data.id}/reopen`).send({}).expect(403);
    const reopened = await ops.post(`/api/ops/tasks/${first.body.data.id}/reopen`).send({}).expect(200);
    expect(reopened.body.data).toMatchObject({ status: 'open', completed_at: null });
    ids.raised = first.body.data.id;
    ids.later = second.body.data.id;
  });

  it('hands a task to someone else, and gives one-off tasks', async () => {
    const ops = await w.as('operations');
    await ops.patch(`/api/ops/tasks/${ids.later}`).send({ due_date: addDays(today, -2) }).expect(400);
    const moved = await ops.patch(`/api/ops/tasks/${ids.later}`).send({ assignee_id: u.accounts, due_date: addDays(today, 3) }).expect(200);
    expect(moved.body.data).toMatchObject({ assignee_id: u.accounts, due_date: addDays(today, 3) });
    await ops.patch(`/api/ops/tasks/${ids.task}`).send({ assignee_id: u.accounts }).expect(409); // already done

    const oneOff = await ops.post('/api/ops/tasks').send({ title: 'Renew the fire extinguisher certificate', assignee_id: u.accounts, due_date: addDays(today, 20) }).expect(201);
    ids.oneOff = oneOff.body.data.id;
    // My list looks a week ahead: the task in 3 days is on it, the one in 20 days is not yet.
    expect((await myTasks('accounts')).tasks.map((t: { id: string }) => t.id)).toEqual([ids.later]);
    await ops.post('/api/ops/tasks').send({ title: 'x', assignee_id: '00000000-0000-4000-8000-000000000000' }).expect(400);
  });

  it('shows what is late', async () => {
    // Nobody can create a task in the past through the app, so age one directly.
    await w.db.execute(sql`update tasks set due_date = ${addDays(today, -2)}::date where id = ${ids.raised}`);
    const ops = await w.as('operations');
    const late = await ops.get('/api/ops/tasks?view=overdue').expect(200);
    expect(late.body.data).toHaveLength(1);
    expect(late.body.data[0]).toMatchObject({ id: ids.raised, overdue: true, assignee_name: 'stores user' });
    expect((await ops.get('/api/ops/tasks?view=today').expect(200)).body.data.map((t: { id: string }) => t.id)).toEqual([ids.task]);
    expect((await ops.get(`/api/ops/tasks?assignee_id=${u.accounts}&status=open`).expect(200)).body.data).toHaveLength(2);

    const overview = (await (await w.as('stores')).get('/api/dashboards/overview').expect(200)).body.data;
    expect(overview.mine).toMatchObject({ tasks_today: 0, tasks_overdue: 1 });
    const board = (await ops.get('/api/dashboards/overview').expect(200)).body.data;
    expect(board.ops).toMatchObject({ tasks_open_today: 0, tasks_overdue: 1 });
  });

  it('the database refuses a closed task without a completion time, and the same scheduled task twice', async () => {
    await expect(w.db.execute(sql`update tasks set status = 'done', completed_at = null where id = ${ids.oneOff}`)).rejects.toThrow();
    await expect(w.db.execute(sql`
      insert into tasks (template_id, scheduled_for, title, assignee_id, due_date)
      values (${ids.daily}, ${today}::date, 'Open the showroom', ${u.store}, ${today}::date)`)).rejects.toThrow();
  });

  it('keeps an asset register with maintenance that rolls forward when the work is done', async () => {
    const ops = await w.as('operations');
    const asset = await ops.post('/api/ops/assets').send({ name: 'CNC Router', category: 'Machine', location: 'Workshop', serial_no: 'CNC-7781', purchase_cost: 450000 }).expect(201);
    ids.asset = asset.body.data.id;
    expect(asset.body.data).toMatchObject({ asset_no: 'AST001', status: 'in_use', purchase_cost: '450000.00' });

    // Every 6 months, last done 5 months ago: due in about a month, inside a 45-day reminder window.
    const lastDone = addMonths(today, -5);
    const service = await ops.post(`/api/ops/assets/${ids.asset}/schedules`).send({
      title: 'Full service', interval_count: 6, interval_unit: 'months', last_done_on: lastDone, assignee_id: u.stores, remind_days_before: 45,
    }).expect(201);
    ids.service = service.body.data.id;
    expect(service.body.data.next_due_on).toBe(addMonths(lastDone, 6));

    // Every 30 days, already 3 days late.
    const lube = await ops.post(`/api/ops/assets/${ids.asset}/schedules`).send({
      title: 'Lubricate the rails', interval_count: 30, interval_unit: 'days', next_due_on: addDays(today, -3),
    }).expect(201);
    ids.lube = lube.body.data.id;
    // No dates given: first due one interval from today.
    const belts = await ops.post(`/api/ops/assets/${ids.asset}/schedules`).send({ title: 'Replace belts', interval_count: 1, interval_unit: 'months', remind_days_before: 0 }).expect(201);
    expect(belts.body.data.next_due_on).toBe(addMonths(today, 1));
    await ops.post(`/api/ops/assets/${ids.asset}/schedules`).send({ title: 'x', interval_count: 0, interval_unit: 'months' }).expect(400);

    const due = await ops.get('/api/ops/maintenance?view=due').expect(200);
    expect(due.body.data.map((s: { title: string; state: string; days_left: number }) => [s.title, s.state, s.days_left]))
      .toEqual([['Lubricate the rails', 'overdue', -3], ['Full service', 'due_soon', expect.any(Number)]]);
    expect((await ops.get('/api/ops/maintenance').expect(200)).body.data).toHaveLength(3);

    // The person who looks after it sees it with their tasks.
    const mine = await myTasks('stores');
    expect(mine.maintenance.map((s: { title: string }) => s.title)).toEqual(['Full service']);
    expect((await (await w.as('stores')).get('/api/dashboards/overview').expect(200)).body.data.mine.maintenance_due).toBe(1);
  });

  it('records the work and moves the next due date on from the day it was done', async () => {
    const ops = await w.as('operations');
    const stores = await w.as('stores');
    const sales = await w.as('sales');
    await sales.post(`/api/ops/schedules/${ids.service}/done`).send({}).expect(403);
    await stores.post(`/api/ops/schedules/${ids.lube}/done`).send({}).expect(403); // not theirs
    await stores.post(`/api/ops/schedules/${ids.service}/done`).send({ done_on: addDays(today, 1) }).expect(400);
    await stores.post(`/api/ops/schedules/${ids.service}/done`).send({ done_on: addMonths(today, -6) }).expect(409); // before the last service
    await stores.post(`/api/ops/schedules/${ids.service}/done`).send({ next_due_on: today }).expect(400);

    const done = await stores.post(`/api/ops/schedules/${ids.service}/done`).send({ cost: 8500, done_by: 'Precision Tools service engineer', notes: 'Spindle bearings replaced' }).expect(201);
    expect(done.body.data).toMatchObject({ last_done_on: today, next_due_on: addMonths(today, 6) });
    const lubed = await ops.post(`/api/ops/schedules/${ids.lube}/done`).send({ done_on: addDays(today, -1) }).expect(201);
    expect(lubed.body.data.next_due_on).toBe(addDays(today, 29)); // 30 days after the day it was done
    const custom = await ops.post(`/api/ops/schedules/${ids.lube}/done`).send({ next_due_on: addDays(today, 10) }).expect(201);
    expect(custom.body.data.next_due_on).toBe(addDays(today, 10));

    expect((await ops.get('/api/ops/maintenance?view=due').expect(200)).body.data).toEqual([]);
    expect((await myTasks('stores')).maintenance).toEqual([]);

    await ops.post(`/api/ops/assets/${ids.asset}/logs`).send({ done_on: today, cost: 1200, notes: 'Emergency stop switch replaced' }).expect(201);
    await ops.post(`/api/ops/assets/${ids.asset}/logs`).send({ done_on: addDays(today, 1), notes: 'x' }).expect(400);
    const page = await ops.get(`/api/ops/assets/${ids.asset}`).expect(200);
    expect(page.body.data.logs).toHaveLength(4);
    expect(page.body.data.logs.find((l: { notes: string }) => l.notes === 'Spindle bearings replaced'))
      .toMatchObject({ schedule_title: 'Full service', cost: '8500.00', done_by: 'Precision Tools service engineer', next_due_on: addMonths(today, 6) });
    expect(page.body.data.logs.find((l: { notes: string }) => l.notes === 'Emergency stop switch replaced'))
      .toMatchObject({ schedule_title: null, done_by: 'operations user' });
    const list = await ops.get('/api/ops/assets').expect(200);
    expect(list.body.data[0]).toMatchObject({ asset_no: 'AST001', schedules: 3, overdue: 0, last_serviced_on: today, maintenance_cost: '9700.00' });
  });

  it('stops the reminders when an asset is retired', async () => {
    const ops = await w.as('operations');
    await ops.patch(`/api/ops/schedules/${ids.lube}`).send({ next_due_on: addDays(today, -1) }).expect(200);
    expect((await ops.get('/api/ops/maintenance?view=due').expect(200)).body.data).toHaveLength(1);
    const retired = await ops.patch(`/api/ops/assets/${ids.asset}`).send({ status: 'retired' }).expect(200);
    expect(retired.body.data).toMatchObject({ status: 'retired', name: 'CNC Router', location: 'Workshop' });
    expect((await ops.get('/api/ops/maintenance?view=due').expect(200)).body.data).toEqual([]);
    await ops.post(`/api/ops/assets/${ids.asset}/schedules`).send({ title: 'x', interval_count: 1, interval_unit: 'months' }).expect(409);
    await ops.post(`/api/ops/schedules/${ids.lube}/done`).send({}).expect(409);
  });

  it('sums the day up on the operations dashboard', async () => {
    const owner = await w.as('owner');
    const d = (await owner.get('/api/ops/dashboard').expect(200)).body.data;
    expect(d.tasks_today).toEqual({ total: 1, done: 1, open: 0, skipped: 0 });
    expect(d.overdue).toEqual({ count: 1, oldest: addDays(today, -2) });
    expect(d.tasks_by_day).toEqual([
      { day: addDays(today, -2), done: 0, skipped: 0, open: 1 }, { day: today, done: 1, skipped: 0, open: 0 },
    ]);
    expect(d.by_person.find((p: { name: string }) => p.name === 'store user')).toMatchObject({ open_today: 0, overdue: 0, done_30_days: 1, on_time_30_days: 1 });
    expect(d.by_person.find((p: { name: string }) => p.name === 'stores user')).toMatchObject({ overdue: 1 });
    expect(d.maintenance).toEqual({ overdue: 0, due_soon: 0 });
    expect(d.assets_by_status).toEqual([{ status: 'retired', count: 1 }]);
    expect(d.maintenance_spend.last_12_months).toBe('9700.00');
  });
});

describe('operations: the schedule creates each task once', () => {
  let w: World;
  let store: string;
  let stores: string;
  const tpl: Record<string, string> = {};
  const todayDow = weekdayOf(today);

  beforeAll(async () => {
    w = await setup();
    store = await userIdOf(w, 'store');
    stores = await userIdOf(w, 'stores');
    const ops = await w.as('operations');
    const make = async (key: string, body: object) => {
      tpl[key] = (await ops.post('/api/ops/templates').send({ assignee_id: store, ...body }).expect(201)).body.data.id;
    };
    await make('everyDay', { title: 'Every day', frequency: 'daily', weekdays: ALL_WEEK });
    await make('monToSat', { title: 'Monday to Saturday', frequency: 'daily' });
    await make('weekly', { title: 'Weekly', frequency: 'weekly', weekdays: [todayDow] });
    await make('monthly', { title: 'Monthly', frequency: 'monthly', month_day: Number(addDays(today, 3).slice(8, 10)) });
    await make('needBased', { title: 'When needed', frequency: 'need_based' });
    await make('later', { title: 'Starts later', frequency: 'daily', weekdays: ALL_WEEK, start_date: addDays(today, 200) });
  });
  afterAll(() => w.close());

  const count = (key: string) => taskCount(w, sql`template_id = ${tpl[key]}`);

  it('creates today\'s tasks when the template is made, and running the schedule adds nothing more', async () => {
    expect(await count('everyDay')).toBe(1);
    expect(await count('monToSat')).toBe(todayDow === 0 ? 0 : 1);
    expect(await count('weekly')).toBe(1);
    expect(await count('monthly')).toBe(0);
    expect(await count('needBased')).toBe(0);
    const before = await taskCount(w);
    expect(await ensureTasks(w.db, today)).toBe(0);
    expect(await ensureTasks(w.db, today)).toBe(0);
    expect(await taskCount(w)).toBe(before);
  });

  it('a week later it has created exactly a week of tasks', async () => {
    // In any 7 days in a row: 7 daily, 6 Monday-to-Saturday, 1 weekly, and the monthly one once (its day is 3 days from today).
    expect(await ensureTasks(w.db, addDays(today, 7))).toBe(7 + 6 + 1 + 1);
    expect(await ensureTasks(w.db, addDays(today, 7))).toBe(0);
    expect(await count('everyDay')).toBe(8);
    expect(await count('weekly')).toBe(2);
    expect(await count('monthly')).toBe(1);
    expect(await count('needBased')).toBe(0);
    expect(await count('later')).toBe(0);
    const [monthly] = await rows<{ due_date: string; scheduled_for: string }>(w.db, sql`select due_date, scheduled_for from tasks where template_id = ${tpl.monthly}`);
    expect(monthly).toEqual({ due_date: addDays(today, 3), scheduled_for: addDays(today, 3) });
    const dupes = await rows(w.db, sql`select template_id, scheduled_for from tasks group by 1, 2 having count(*) > 1`);
    expect(dupes).toEqual([]);
  });

  it('two people opening the screen at the same moment do not double anything', async () => {
    const day = addDays(today, 8);
    const created = await Promise.all([ensureTasks(w.db, day), ensureTasks(w.db, day), ensureTasks(w.db, day)]);
    const expected = 1 + (weekdayOf(day) === 0 ? 0 : 1) + (weekdayOf(day) === todayDow ? 1 : 0);
    expect(created.reduce((a, b) => a + b, 0)).toBe(expected);
    expect(await taskCount(w, sql`scheduled_for = ${day}::date`)).toBe(expected);
  });

  it('a switched-off template stops, and a changed assignee applies from the next task on', async () => {
    const ops = await w.as('operations');
    await ops.patch(`/api/ops/templates/${tpl.everyDay}`).send({ active: false }).expect(200);
    const changed = await ops.patch(`/api/ops/templates/${tpl.monToSat}`).send({ assignee_id: stores }).expect(200);
    expect(changed.body.data).toMatchObject({ assignee_id: stores, frequency: 'daily', weekdays: [1, 2, 3, 4, 5, 6], title: 'Monday to Saturday' });
    const before = await count('everyDay');
    const day = addDays(today, 15); // a full week after the last run
    await ensureTasks(w.db, day);
    expect(await count('everyDay')).toBe(before);
    const assignees = await rows<{ assignee_id: string; n: number }>(w.db, sql`
      select assignee_id, count(*)::int as n from tasks where template_id = ${tpl.monToSat} and scheduled_for > ${addDays(today, 8)}::date group by 1`);
    expect(assignees).toEqual([{ assignee_id: stores, n: 6 }]);
    const earlier = await rows<{ assignee_id: string }>(w.db, sql`
      select distinct assignee_id from tasks where template_id = ${tpl.monToSat} and scheduled_for <= ${addDays(today, 8)}::date`);
    expect(earlier).toEqual([{ assignee_id: store }]);
  });

  it('after a long gap it goes back a month, not for ever', async () => {
    const before = await count('weekly');
    const day = addDays(today, 150);
    await ensureTasks(w.db, day);
    // The window is the last 32 days up to that day: 4 or 5 of any one weekday.
    let expected = 0;
    for (let d = addDays(day, -31); d <= day; d = addDays(d, 1)) if (weekdayOf(d) === todayDow) expected++;
    expect(await count('weekly')).toBe(before + expected);
    const [oldest] = await rows<{ d: string }>(w.db, sql`select min(scheduled_for) as d from tasks where template_id = ${tpl.weekly} and scheduled_for > ${addDays(today, 15)}::date`);
    expect(oldest!.d >= addDays(day, -31)).toBe(true);
  });

  it('starts a template on its start date', async () => {
    expect(await count('later')).toBe(0);
    await ensureTasks(w.db, addDays(today, 201));
    expect(await count('later')).toBe(2); // day 200 and day 201
  });
});
