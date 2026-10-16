import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

/**
 * The task board (Operations → Tasks): a task is dragged between To do, In progress, Done and Could
 * not do. The rules of each column are the task's own rules: Done needs the checklist ticked, Could
 * not do needs a reason, and only operations may take a closed task back.
 */
const today = istDate();
let w: World;
const u: Record<string, string> = {};

const userIdOf = async (role: string) => (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;
const giveTask = async (title: string, assignee: string, checklist: string[] = []) =>
  (await (await w.as('operations')).post('/api/ops/tasks').send({ title, assignee_id: assignee, due_date: today, checklist }).expect(201)).body.data.id as string;
const taskOnBoard = async (id: string, role: 'operations' | 'owner' = 'operations') =>
  ((await (await w.as(role)).get('/api/ops/tasks?view=board&limit=500').expect(200)).body.data as any[]).find((t) => t.id === id);
const move = async (role: 'store' | 'sales' | 'operations', id: string, to: string, reason?: string) =>
  (await w.as(role)).post(`/api/ops/tasks/${id}/move`).send({ to, reason });

beforeAll(async () => {
  w = await setup();
  for (const role of ['store', 'sales', 'operations']) u[role] = await userIdOf(role);
});
afterAll(() => w.close());

describe('the task board', () => {
  it('starts a task in To do; the person it is given to moves it to In progress and back', async () => {
    const id = await giveTask('Set up the Diwali display', u.store!);
    expect((await taskOnBoard(id)).stage).toBe('todo');

    const started = await move('store', id, 'in_progress');
    expect(started.status).toBe(200);
    expect(started.body.data.started_at).toBeTruthy();
    const onBoard = await taskOnBoard(id);
    expect(onBoard.stage).toBe('in_progress');
    expect(onBoard.status).toBe('open'); // still counted as open (and late, when it is) everywhere else

    // Dropped on its own column again: nothing changes, nothing fails.
    const again = await move('store', id, 'in_progress');
    expect(again.status).toBe(200);
    expect(again.body.data.started_at).toBe(started.body.data.started_at);

    await move('store', id, 'todo').then((r) => expect(r.status).toBe(200));
    expect((await taskOnBoard(id)).stage).toBe('todo');
    expect((await taskOnBoard(id)).started_at).toBeNull();

    // In progress is still open work on the person's own list.
    await move('store', id, 'in_progress');
    const mine = (await (await w.as('store')).get('/api/ops/my-tasks').expect(200)).body.data.tasks as any[];
    expect(mine.find((t) => t.id === id)?.stage).toBe('in_progress');
  });

  it('does not let anyone else move a task given to someone', async () => {
    const id = await giveTask('Count the cash float', u.store!);
    const res = await move('sales', id, 'in_progress');
    expect(res.status).toBe(403);
    expect((await taskOnBoard(id)).stage).toBe('todo');
    // Operations can move anyone's task.
    expect((await move('operations', id, 'in_progress')).status).toBe(200);
  });

  it('moves to Done only once the checklist is ticked', async () => {
    const id = await giveTask('Open the showroom', u.store!, ['Lights on', 'Cash float counted']);
    await move('store', id, 'in_progress');
    const refused = await move('store', id, 'done');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/2 checklist item/);
    expect((await taskOnBoard(id)).stage).toBe('in_progress');

    const store = await w.as('store');
    await store.post(`/api/ops/tasks/${id}/checklist`).send({ index: 0, done: true }).expect(200);
    await store.post(`/api/ops/tasks/${id}/checklist`).send({ index: 1, done: true }).expect(200);
    const done = await move('store', id, 'done');
    expect(done.status).toBe(200);
    const onBoard = await taskOnBoard(id);
    expect(onBoard).toMatchObject({ stage: 'done', status: 'done' });
    expect(onBoard.completed_at).toBeTruthy();
    expect(onBoard.started_at).toBeTruthy(); // when work began is kept
  });

  it('moves to Could not do only with the reason', async () => {
    const id = await giveTask('Deliver to Pune Boards', u.store!);
    const refused = await move('store', id, 'skipped');
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/why/i);
    expect((await taskOnBoard(id)).stage).toBe('todo');

    const ok = await move('store', id, 'skipped', 'The tempo did not come');
    expect(ok.status).toBe(200);
    expect(await taskOnBoard(id)).toMatchObject({ stage: 'skipped', note: 'The tempo did not come' });
  });

  it('takes a closed task back only for operations, and undoes it all when the last step is refused', async () => {
    const id = await giveTask('Check the seal number', u.store!, ['Seal number matches']);
    await move('store', id, 'skipped', 'Container came late');

    // The person it was given to cannot reopen it from the board.
    expect((await move('store', id, 'in_progress')).status).toBe(403);
    expect((await taskOnBoard(id)).stage).toBe('skipped');

    // Operations drags it to Done, but the checklist was never ticked: refused, and it stays closed as it was.
    const refused = await move('operations', id, 'done');
    expect(refused.status).toBe(409);
    expect(await taskOnBoard(id)).toMatchObject({ stage: 'skipped', note: 'Container came late' });

    // Back to In progress: reopened and started, in one step.
    const back = await move('operations', id, 'in_progress');
    expect(back.status).toBe(200);
    expect(await taskOnBoard(id)).toMatchObject({ stage: 'in_progress', status: 'open', completed_at: null });
    const trail = await rows<{ action: string }>(w.db, sql`select action from audit_log where entity_id = ${id} order by id`);
    expect(trail.map((t) => t.action)).toEqual(['create', 'skip', 'reopen', 'move']);
  });

  it('does not reopen a task of a project that is closed', async () => {
    const ops = await w.as('operations');
    const project = (await ops.post('/api/ops/projects').send({ name: 'Stall at the skate jam', owner_id: u.operations, deadline: addDays(today, 10) }).expect(201)).body.data;
    const task = (await ops.post(`/api/ops/projects/${project.id}/tasks`).send({ title: 'Book the stall', assignee_id: u.sales, due_date: addDays(today, 2) }).expect(201)).body.data;
    await ops.patch(`/api/ops/projects/${project.id}`).send({ status: 'cancelled' }).expect(200);
    expect((await taskOnBoard(task.id)).stage).toBe('skipped');

    const res = await move('operations', task.id, 'todo');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/reopen the project first/);
  });

  it('shows open work and what closed in the last fortnight, not older history', async () => {
    const old = await giveTask('Last month\'s stock count', u.store!);
    await move('store', old, 'done');
    expect(await taskOnBoard(old)).toBeTruthy();
    await w.db.execute(sql`update tasks set completed_at = now() - interval '20 days' where id = ${old}`);
    expect(await taskOnBoard(old)).toBeUndefined();
    // It is still in the full list.
    const all = (await (await w.as('operations')).get('/api/ops/tasks?limit=500').expect(200)).body.data as any[];
    expect(all.some((t) => t.id === old)).toBe(true);
  });

  it('refuses a column that does not exist', async () => {
    const id = await giveTask('Anything', u.store!);
    expect((await move('store', id, 'archived')).status).toBe(400);
  });
});
