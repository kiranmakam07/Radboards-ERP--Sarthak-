import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate, weekStart } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

const today = istDate();
let w: World;
const u: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await setup();
  for (const r of await rows<{ id: string; role: string }>(w.db, sql`select id, role::text as role from users`)) u[r.role] = r.id;
  const person = async (name: string, phone: string, department: string, user_id?: string) =>
    (await (await w.as('admin')).post('/api/hr/employees').send({ name, phone, department, designation: 'Staff', join_date: '2026-01-01', monthly_salary: 30000, user_id }).expect(201)).body.data.id;
  ids.asha = await person('Asha Kale', '9844000001', 'Workshop', u.stores);
  ids.bala = await person('Bala Iyer', '9844000002', 'Workshop');
  ids.chetan = await person('Chetan Rao', '9844000003', 'Sales');
  const ops = await w.as('operations');
  ids.router = (await ops.post('/api/ops/assets').send({ name: 'CNC Router', category: 'Machine' }).expect(201)).body.data.id;
});
afterAll(() => w.close());

describe('task deadlines', () => {
  it('a task is late from the minute its deadline passes, not only from the next day', async () => {
    const ops = await w.as('operations');
    const soon = await ops.post('/api/ops/tasks').send({ title: 'Send the courier', assignee_id: u.store, due_date: today, due_time: '23:59' }).expect(201);
    const missed = await ops.post('/api/ops/tasks').send({ title: 'Call the transporter', assignee_id: u.store, due_date: today, due_time: '10:30' }).expect(201);
    expect(soon.body.data.due_time).toBe('23:59:00');
    await ops.post('/api/ops/tasks').send({ title: 'x', assignee_id: u.store, due_date: today, due_time: '25:00' }).expect(400);
    // Pin both deadlines relative to this moment, so the test does not depend on the time of day it runs at.
    await w.db.execute(sql`update tasks set due_date = ((now() at time zone 'Asia/Kolkata') + interval '5 minutes')::date,
                                           due_time = ((now() at time zone 'Asia/Kolkata') + interval '5 minutes')::time where id = ${soon.body.data.id}`);
    await w.db.execute(sql`update tasks set due_date = ((now() at time zone 'Asia/Kolkata') - interval '5 minutes')::date,
                                           due_time = ((now() at time zone 'Asia/Kolkata') - interval '5 minutes')::time where id = ${missed.body.data.id}`);

    const mine = (await (await w.as('store')).get('/api/ops/my-tasks').expect(200)).body.data.tasks;
    const byTitle = Object.fromEntries(mine.map((t: { title: string }) => [t.title, t]));
    expect(byTitle['Send the courier'].overdue).toBe(false);
    expect(byTitle['Call the transporter'].overdue).toBe(true);
    expect(byTitle['Call the transporter'].due_time).toMatch(/^\d\d:\d\d$/);
    const late = (await ops.get('/api/ops/tasks?view=overdue').expect(200)).body.data;
    expect(late.map((t: { title: string }) => t.title)).toEqual(['Call the transporter']);
    const board = (await ops.get('/api/dashboards/overview').expect(200)).body.data.ops;
    expect(board.tasks_overdue).toBe(1);

    // Moving the deadline to later clears it; a routine can carry a finish-by time for its tasks.
    await ops.patch(`/api/ops/tasks/${missed.body.data.id}`).send({ due_date: addDays(today, 1), due_time: '' }).expect(200);
    expect((await ops.get('/api/ops/tasks?view=overdue').expect(200)).body.data).toEqual([]);
    const routine = await ops.post('/api/ops/templates').send({ title: 'Bank the cash', frequency: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], assignee_id: u.accounts, due_time: '11:00' }).expect(201);
    expect(routine.body.data.due_time).toBe('11:00:00');
    const raised = (await (await w.as('accounts')).get('/api/ops/my-tasks').expect(200)).body.data.tasks;
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ title: 'Bank the cash', due_date: today, due_time: '11:00' });
  });
});

describe('projects', () => {
  it('is run by operations or by its owner, and nobody else', async () => {
    const ops = await w.as('operations');
    const sales = await w.as('sales');
    const store = await w.as('store');
    await sales.get('/api/ops/projects').expect(403);
    await sales.post('/api/ops/projects').send({ name: 'x', owner_id: u.sales }).expect(403);

    const made = await ops.post('/api/ops/projects').send({ name: 'Diwali exhibition stall', owner_id: u.sales, start_date: today, deadline: addDays(today, 30) }).expect(201);
    ids.project = made.body.data.id;
    expect(made.body.data).toMatchObject({ project_no: 'PRJ001', status: 'planned', deadline: addDays(today, 30) });
    await ops.post('/api/ops/projects').send({ name: 'x', owner_id: u.sales, start_date: today, deadline: addDays(today, -1) }).expect(400);

    // The owner is in sales, with no operations access, and can still open and run their own project.
    const page = await sales.get(`/api/ops/projects/${ids.project}`).expect(200);
    expect(page.body.data).toMatchObject({ owner_name: 'sales user', can_manage: true, days_left: 30, overdue: false });
    await store.get(`/api/ops/projects/${ids.project}`).expect(403);
    await store.post(`/api/ops/projects/${ids.project}/tasks`).send({ title: 'x', assignee_id: u.store, due_date: today }).expect(403);
    await store.patch(`/api/ops/projects/${ids.project}`).send({ status: 'cancelled' }).expect(403);
  });

  it('holds tasks with a person and a deadline each, inside the project\'s own deadline', async () => {
    const sales = await w.as('sales');
    const add = (body: object) => sales.post(`/api/ops/projects/${ids.project}/tasks`).send(body);
    await add({ title: 'Too late', assignee_id: u.stores, due_date: addDays(today, 31) }).expect(400);
    await add({ title: 'Backwards', assignee_id: u.stores, start_date: addDays(today, 5), due_date: addDays(today, 4) }).expect(400);
    await add({ title: 'Yesterday', assignee_id: u.stores, due_date: addDays(today, -1) }).expect(400);
    await add({ title: 'No deadline', assignee_id: u.stores }).expect(400);

    const stall = await add({ title: 'Book the stall', assignee_id: u.sales, due_date: addDays(today, 3), checklist: ['Pay the deposit'] }).expect(201);
    const boards = await add({ title: 'Build 40 display boards', assignee_id: u.stores, start_date: addDays(today, 2), due_date: addDays(today, 20), due_time: '18:00' }).expect(201);
    const banners = await add({ title: 'Print banners', assignee_id: u.marketing, due_date: addDays(today, 25) }).expect(201);
    Object.assign(ids, { stall: stall.body.data.id, boards: boards.body.data.id, banners: banners.body.data.id });

    const page = (await sales.get(`/api/ops/projects/${ids.project}`).expect(200)).body.data;
    expect(page.status).toBe('active'); // the first task starts the project
    expect(page.tasks.map((t: { title: string }) => t.title)).toEqual(['Book the stall', 'Build 40 display boards', 'Print banners']);
    expect(page.tasks[1]).toMatchObject({ start_date: addDays(today, 2), due_date: addDays(today, 20), due_time: '18:00', project_name: 'Diwali exhibition stall' });

    // Each person sees their project task with their other work, however far off the deadline is.
    const mine = (await (await w.as('stores')).get('/api/ops/my-tasks').expect(200)).body.data.tasks;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Build 40 display boards', project_no: 'PRJ001', overdue: false });
    const listed = (await (await w.as('operations')).get(`/api/ops/tasks?project_id=${ids.project}`).expect(200)).body.data;
    expect(listed).toHaveLength(3);
  });

  it('tracks progress, and cannot be closed or have its deadline cut while work is still open', async () => {
    const ops = await w.as('operations');
    const sales = await w.as('sales');
    await sales.post(`/api/ops/tasks/${ids.stall}/checklist`).send({ index: 0, done: true }).expect(200);
    await sales.post(`/api/ops/tasks/${ids.stall}/complete`).send({}).expect(200);

    const list = (await ops.get('/api/ops/projects?view=live').expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ project_no: 'PRJ001', tasks: 3, tasks_done: 1, tasks_open: 2, tasks_late: 0, owner_name: 'sales user' });

    const early = await sales.patch(`/api/ops/projects/${ids.project}`).send({ deadline: addDays(today, 22) }).expect(409);
    expect(early.body.error.message).toContain('1 open task(s)'); // the banners, due on day 25
    const blocked = await sales.patch(`/api/ops/projects/${ids.project}`).send({ status: 'done' }).expect(409);
    expect(blocked.body.error.details.open_tasks).toBe(2);
    await expect(w.db.execute(sql`update projects set status = 'done' where id = ${ids.project}`)).rejects.toThrow(); // needs a completion date

    await ops.patch(`/api/ops/tasks/${ids.banners}`).send({ due_date: addDays(today, 31) }).expect(400); // past the project's deadline
    await ops.patch(`/api/ops/tasks/${ids.banners}`).send({ due_date: addDays(today, 21) }).expect(200);
    await sales.patch(`/api/ops/projects/${ids.project}`).send({ deadline: addDays(today, 22) }).expect(200);
  });
});

describe('resource allocation', () => {
  const D = (n: number) => addDays(today, n);

  it('commits people and machines to work for a period and a share of their time', async () => {
    const ops = await w.as('operations');
    const allocate = (body: object) => ops.post('/api/ops/allocations').send(body);
    await (await w.as('sales')).post('/api/ops/allocations').send({}).expect(403);

    const first = await allocate({ project_id: ids.project, employee_id: ids.asha, from_date: D(0), to_date: D(20), percent: 60, role: 'Board maker' }).expect(201);
    ids.alloc = first.body.data.id;
    expect(first.body.data.peak).toBe(60);
    await allocate({ label: 'Showroom duty', employee_id: ids.asha, from_date: D(0), to_date: D(6), percent: 40 }).expect(201); // exactly 100%, fine
    await allocate({ project_id: ids.project, asset_id: ids.router, from_date: D(2), to_date: D(20) }).expect(201);

    await allocate({ project_id: ids.project, employee_id: ids.asha, asset_id: ids.router, from_date: D(0), to_date: D(1) }).expect(400);
    await allocate({ project_id: ids.project, from_date: D(0), to_date: D(1) }).expect(400);
    await allocate({ employee_id: ids.bala, from_date: D(0), to_date: D(1) }).expect(400); // no project and no description
    await allocate({ project_id: ids.project, employee_id: ids.bala, from_date: D(5), to_date: D(4) }).expect(400);
    await allocate({ project_id: ids.project, employee_id: ids.bala, from_date: D(0), to_date: D(4), percent: 0 }).expect(400);
    await allocate({ project_id: ids.project, employee_id: ids.bala, from_date: D(0), to_date: D(4), percent: 120 }).expect(400);
  });

  it('refuses to promise more than all of someone\'s time, unless told to go ahead', async () => {
    const ops = await w.as('operations');
    const body = { label: 'Dealer visits', employee_id: ids.asha, from_date: D(4), to_date: D(10), percent: 30 };
    const clash = await ops.post('/api/ops/allocations').send(body).expect(409);
    expect(clash.body.error.message).toBe('Asha Kale would be committed for 130% of their time in that period');
    expect(clash.body.error.details.peak).toBe(130); // days 4 to 6: 60 + 40 + 30
    expect(clash.body.error.details.clashes.map((c: { work: string; percent: number }) => [c.work, c.percent]))
      .toEqual([['Diwali exhibition stall', 60], ['Showroom duty', 40]]);

    // From day 7 the showroom duty is over, so the same 30% fits without any override.
    await ops.post('/api/ops/allocations').send({ ...body, from_date: D(7) }).expect(201);
    // A machine cannot be in two jobs at once either.
    await ops.post('/api/ops/allocations').send({ label: 'Sample run', asset_id: ids.router, from_date: D(10), to_date: D(11) }).expect(409);
    const forced = await ops.post('/api/ops/allocations').send({ label: 'Sample run', asset_id: ids.router, from_date: D(10), to_date: D(11), allow_over: true }).expect(201);
    expect(forced.body.data.peak).toBe(200);

    // Changing an allocation is checked the same way, without counting itself.
    await ops.patch(`/api/ops/allocations/${ids.alloc}`).send({ percent: 80 }).expect(409);
    const eased = await ops.patch(`/api/ops/allocations/${ids.alloc}`).send({ percent: 50, role: 'Lead board maker' }).expect(200);
    expect(eased.body.data).toMatchObject({ percent: 50, role: 'Lead board maker', from_date: D(0), to_date: D(20) });
    await expect(w.db.execute(sql`update allocations set percent = 150 where id = ${ids.alloc}`)).rejects.toThrow();
  });

  it('shows everyone week by week, with the busiest day of each week', async () => {
    const ops = await w.as('operations');
    const board = (await ops.get(`/api/ops/resources?from=${today}&weeks=4`).expect(200)).body.data;
    expect(board.from).toBe(weekStart(today));
    expect(board.weeks).toHaveLength(4);
    expect(board.weeks[1]).toEqual({ start: addDays(weekStart(today), 7), end: addDays(weekStart(today), 13) });
    expect(board.people.map((p: { name: string }) => p.name)).toEqual(['Chetan Rao', 'Asha Kale', 'Bala Iyer']); // by department, then name
    expect(JSON.stringify(board)).not.toContain('monthly_salary'); // pay stays in HR

    const asha = board.people.find((p: { name: string }) => p.name === 'Asha Kale');
    expect(asha.allocations).toHaveLength(3);
    expect(asha.load[0]).toBe(90); // this week: 50% project + 40% showroom
    expect(Math.max(...asha.load)).toBe(90);
    expect(asha.open_tasks).toBe(1); // her sign-in is the stores user, who has the display boards task
    expect(board.people.find((p: { name: string }) => p.name === 'Bala Iyer').load).toEqual([0, 0, 0, 0]);
    const router = board.assets.find((a: { name: string }) => a.name === 'CNC Router');
    expect(Math.max(...router.load)).toBe(200); // the forced double booking shows

    const people = (await ops.get('/api/ops/people').expect(200)).body.data;
    expect(people).toHaveLength(3);
    expect(Object.keys(people[0]).sort()).toEqual(['department', 'designation', 'employee_no', 'id', 'name', 'user_id']);
    const page = (await ops.get(`/api/ops/projects/${ids.project}`).expect(200)).body.data;
    expect(page.allocations.map((a: { resource_name: string }) => a.resource_name)).toEqual(['Asha Kale', 'CNC Router']);
  });

  it('does not allocate someone who has left or a machine that is retired', async () => {
    const hr = await w.as('hr');
    const ops = await w.as('operations');
    await hr.post(`/api/hr/employees/${ids.chetan}/exit`).send({ left_on: today }).expect(200);
    const gone = await ops.post('/api/ops/allocations').send({ project_id: ids.project, employee_id: ids.chetan, from_date: D(1), to_date: D(2) }).expect(409);
    expect(gone.body.error.message).toContain('has left');
    const old = (await ops.post('/api/ops/assets').send({ name: 'Old lathe', category: 'Machine', status: 'retired' }).expect(201)).body.data.id;
    await ops.post('/api/ops/allocations').send({ project_id: ids.project, asset_id: old, from_date: D(1), to_date: D(2) }).expect(409);
  });

  it('removes an allocation, keeping what it was in the audit trail', async () => {
    const ops = await w.as('operations');
    const list = (await ops.get(`/api/ops/allocations?asset_id=${ids.router}`).expect(200)).body.data;
    const sample = list.find((a: { work: string }) => a.work === 'Sample run');
    await ops.delete(`/api/ops/allocations/${sample.id}`).expect(200);
    await ops.delete(`/api/ops/allocations/${sample.id}`).expect(404);
    const [log] = await rows<{ before: { percent: number } }>(w.db, sql`select before from audit_log where entity = 'allocation' and action = 'remove'`);
    expect(log!.before.percent).toBe(100);
  });
});

describe('closing a project', () => {
  it('frees its people from today when it is cancelled, and closes its open tasks', async () => {
    const ops = await w.as('operations');
    const second = (await ops.post('/api/ops/projects').send({ name: 'New website photos', owner_id: u.marketing, deadline: addDays(today, 40) }).expect(201)).body.data.id;
    const task = (await ops.post(`/api/ops/projects/${second}/tasks`).send({ title: 'Shoot the boards', assignee_id: u.marketing, due_date: addDays(today, 10) }).expect(201)).body.data.id;
    await ops.post('/api/ops/allocations').send({ project_id: second, employee_id: ids.bala, from_date: addDays(today, -3), to_date: addDays(today, 10), percent: 50 }).expect(201);
    await ops.post('/api/ops/allocations').send({ project_id: second, employee_id: ids.bala, from_date: addDays(today, 15), to_date: addDays(today, 20), percent: 50 }).expect(201);

    const cancelled = await ops.patch(`/api/ops/projects/${second}`).send({ status: 'cancelled' }).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', completed_on: null });
    const [t] = await rows<{ status: string; note: string }>(w.db, sql`select status, note from tasks where id = ${task}`);
    expect(t).toEqual({ status: 'skipped', note: 'Project cancelled' });
    const left = (await ops.get(`/api/ops/allocations?employee_id=${ids.bala}`).expect(200)).body.data;
    expect(left.map((a: { from_date: string; to_date: string }) => [a.from_date, a.to_date])).toEqual([[addDays(today, -3), today]]);

    await ops.post(`/api/ops/projects/${second}/tasks`).send({ title: 'x', assignee_id: u.marketing, due_date: addDays(today, 5) }).expect(409);
    await ops.post('/api/ops/allocations').send({ project_id: second, employee_id: ids.bala, from_date: addDays(today, 1), to_date: addDays(today, 2) }).expect(409);
  });

  it('is done once every task is closed, and can be reopened', async () => {
    const ops = await w.as('operations');
    const sales = await w.as('sales');
    await (await w.as('stores')).post(`/api/ops/tasks/${ids.boards}/complete`).send({}).expect(200);
    await (await w.as('marketing')).post(`/api/ops/tasks/${ids.banners}/skip`).send({ reason: 'Reusing last year\'s banners' }).expect(200);
    const done = await sales.patch(`/api/ops/projects/${ids.project}`).send({ status: 'done' }).expect(200);
    expect(done.body.data).toMatchObject({ status: 'done', completed_on: today });

    const list = (await ops.get('/api/ops/projects').expect(200)).body.data.find((p: { id: string }) => p.id === ids.project);
    expect(list).toMatchObject({ tasks: 2, tasks_done: 2, tasks_open: 0 }); // the skipped banners are not counted as work
    const asha = (await ops.get(`/api/ops/allocations?employee_id=${ids.asha}&project_id=${ids.project}`).expect(200)).body.data;
    expect(asha[0].to_date).toBe(today); // her 20 days on the project end the day it finished

    const back = await sales.patch(`/api/ops/projects/${ids.project}`).send({ status: 'active' }).expect(200);
    expect(back.body.data).toMatchObject({ status: 'active', completed_on: null });
  });
});
