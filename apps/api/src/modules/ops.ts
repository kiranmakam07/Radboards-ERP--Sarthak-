import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  ASSET_STATUSES, INTERVAL_UNITS, TASK_FREQUENCIES, TASK_STAGES, TASK_STATUSES, addDays, addMonths, can, formatDate, isTaskDueOn, istDate,
  type IntervalUnit, type TaskStage,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { nextNumber } from '../core/numbering';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { assets, maintenanceLogs, maintenanceSchedules, projects, settings, taskTemplates, tasks, users } from '../db/schema';
import { badRequest, conflict, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zClock, zDate, zId, zListQuery, zMoney, zText, type Ctx, zPatch } from '../lib/http';

/**
 * Operations: routines, tasks, assets and their maintenance.
 *
 * A routine (a task template) says what must be done, by whom and how often. The tasks it calls for
 * are created by ensureTasks the first time anyone opens a task screen each day, so there is no
 * background job to keep running. An asset has maintenance schedules, each with a next due date
 * that moves on when the work is logged. Projects and who is promised to them are in projects.ts.
 */

type Template = typeof taskTemplates.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Schedule = typeof maintenanceSchedules.$inferSelect;

/** After a long gap (holidays, a server that was off) only this many days of missed tasks are created. */
const BACKFILL_DAYS = 31;

/** A person work can be given to: someone with a sign-in that is switched on. */
export async function activeUser(tx: DB, id: string): Promise<{ id: string; name: string }> {
  const [u] = await tx.select({ id: users.id, name: users.name, active: users.active }).from(users).where(eq(users.id, id));
  if (!u || !u.active) throw badRequest('Pick a person who has an active sign-in');
  return u;
}

// ---------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------
/** Create the tasks these templates call for on each day in the range. Safe to run any number of times. */
async function createDueTasks(tx: DB, templates: Template[], from: string, through: string): Promise<number> {
  const values: (typeof tasks.$inferInsert)[] = [];
  for (const t of templates) {
    if (!t.active || t.frequency === 'need_based') continue;
    for (let day = t.startDate > from ? t.startDate : from; day <= through; day = addDays(day, 1)) {
      if (!isTaskDueOn({ frequency: t.frequency, weekdays: t.weekdays, monthDay: t.monthDay }, day)) continue;
      values.push({
        templateId: t.id, scheduledFor: day, title: t.title, description: t.description, assigneeId: t.assigneeId, dueDate: day,
        dueTime: t.dueTime, checklist: t.checklist.map((text) => ({ text, done: false })),
      });
    }
  }
  let created = 0;
  for (let i = 0; i < values.length; i += 500) {
    const inserted = await tx.insert(tasks).values(values.slice(i, i + 500))
      .onConflictDoNothing({ target: [tasks.templateId, tasks.scheduledFor] })
      .returning({ id: tasks.id });
    created += inserted.length;
  }
  return created;
}

/**
 * Bring the task list up to today. There is no background job to depend on: this runs when
 * anyone opens a task screen, does nothing if today is already done, and two people opening
 * the screen at the same moment cannot create a task twice (row lock, plus a unique key on
 * template and day).
 */
export async function ensureTasks(db: DB, today: string = istDate()): Promise<number> {
  const done = await getSetting(db, 'tasks_generated_through');
  if (done && done >= today) return 0;
  return db.transaction(async (trx) => {
    const tx = trx as unknown as DB;
    await tx.insert(settings).values({ key: 'tasks_generated_through', value: null }).onConflictDoNothing();
    await tx.execute(sql`select 1 from settings where key = 'tasks_generated_through' for update`);
    const last = await getSetting(tx, 'tasks_generated_through');
    if (last && last >= today) return 0;
    const earliest = addDays(today, -BACKFILL_DAYS);
    const from = last ? (addDays(last, 1) > earliest ? addDays(last, 1) : earliest) : today;
    const templates = await tx.select().from(taskTemplates).where(eq(taskTemplates.active, true));
    const created = await createDueTasks(tx, templates, from, today);
    await setSetting(tx, 'tasks_generated_through', today, null);
    return created;
  });
}

const zTemplate = z.object({
  title: zText(150),
  description: emptyToNull(z.string().trim().max(2000)).optional(),
  frequency: z.enum(TASK_FREQUENCIES),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),
  month_day: emptyToNull(z.coerce.number().int().min(1).max(31)).optional(),
  assignee_id: zId,
  checklist: z.array(zText(200)).max(30).prefault([]),
  /** Finish by this time on the day; blank means any time that day. */
  due_time: emptyToNull(zClock).optional(),
  start_date: emptyToNull(zDate).optional(),
  active: z.boolean().optional(),
});

/** Work out the schedule columns for a frequency, refusing combinations that could never run. */
function scheduleOf(frequency: Template['frequency'], weekdays: number[] | undefined, monthDay: number | null | undefined) {
  if (frequency === 'daily') {
    // Monday to Saturday unless told otherwise.
    const days = weekdays && weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5, 6];
    return { weekdays: [...new Set(days)].sort(), monthDay: null };
  }
  if (frequency === 'weekly') {
    if (!weekdays || weekdays.length === 0) throw badRequest('Pick the day of the week');
    return { weekdays: [...new Set(weekdays)].sort(), monthDay: null };
  }
  if (frequency === 'monthly') {
    if (!monthDay) throw badRequest('Pick the day of the month');
    return { weekdays: [], monthDay };
  }
  return { weekdays: [], monthDay: null };
}

/** A project's task cannot be due after the project itself. */
export async function deadlineFitsProject(tx: DB, projectId: string | null, dueDate: string): Promise<void> {
  if (!projectId) return;
  const [p] = await tx.select({ name: projects.name, deadline: projects.deadline }).from(projects).where(eq(projects.id, projectId));
  if (p?.deadline && dueDate > p.deadline) {
    throw badRequest(`"${p.name}" is due on ${formatDate(p.deadline)}. A task in it cannot be due later than that; move the project's deadline first.`);
  }
}

/** Take a task for changing, so two people acting on it at once go one after the other. */
export async function lockTask(tx: DB, id: string): Promise<Task> {
  const [t] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
  return must(t, 'Task');
}

/** A task is worked by the person it is given to; whoever runs operations can act on any of them. */
function mustBeMine(ctx: Ctx, task: Task): void {
  if (!ctx.user || (task.assigneeId !== ctx.user.id && !can(ctx.user.role, 'ops:manage'))) {
    throw forbidden('This task is assigned to someone else');
  }
}

/** Which column of the board a task is in: open ones by whether work has started, closed ones by how they closed. */
export const stageOf = (task: Pick<Task, 'status' | 'startedAt'>): TaskStage =>
  (task.status === 'open' ? (task.startedAt ? 'in_progress' : 'todo') : task.status);

/** Mark a task done. Every checklist item must be ticked first. */
export async function completeTask(ctx: Ctx, id: string, noteText: string | null): Promise<Task> {
  const task = await lockTask(ctx.tx, id);
  mustBeMine(ctx, task);
  if (task.status !== 'open') throw conflict(`This task is already ${task.status}`);
  const left = task.checklist.filter((c) => !c.done).length;
  if (left > 0) throw conflict(`${left} checklist item(s) are not ticked yet`);
  const [updated] = await ctx.tx.update(tasks)
    .set({ status: 'done', completedAt: new Date(), completedBy: ctx.user?.id ?? null, note: noteText, updatedAt: new Date() })
    .where(eq(tasks.id, id)).returning();
  await audit(ctx, 'task', id, 'complete', { status: 'open' }, { status: 'done' });
  return updated!;
}

/** It could not be done. The reason is kept, so a skipped task is never mistaken for a finished one. */
export async function skipTask(ctx: Ctx, id: string, reason: string): Promise<Task> {
  const task = await lockTask(ctx.tx, id);
  mustBeMine(ctx, task);
  if (task.status !== 'open') throw conflict(`This task is already ${task.status}`);
  const [updated] = await ctx.tx.update(tasks)
    .set({ status: 'skipped', completedAt: new Date(), completedBy: ctx.user?.id ?? null, note: reason, updatedAt: new Date() })
    .where(eq(tasks.id, id)).returning();
  await audit(ctx, 'task', id, 'skip', { status: 'open' }, { status: 'skipped', reason });
  return updated!;
}

/**
 * Move a task to another column of the board. Between the open columns (to do, in progress) the
 * person it is given to moves it freely. Done follows completeTask (every checklist line ticked) and
 * Could not do needs the reason, as from the task itself. Taking a closed task back reopens it, which
 * only operations may do, and not while its project is finished or cancelled. All in one transaction:
 * if the last step is refused, the reopening is undone with it.
 */
export async function moveTask(ctx: Ctx, id: string, to: TaskStage, reason: string | null): Promise<Task> {
  let task = await lockTask(ctx.tx, id);
  mustBeMine(ctx, task);
  const from = stageOf(task);
  if (from === to) return task;
  if (task.status !== 'open') {
    if (!ctx.user || !can(ctx.user.role, 'ops:manage')) throw forbidden('Only operations can reopen a task that is closed');
    if (task.projectId) {
      const [project] = await ctx.tx.select({ status: projects.status }).from(projects).where(eq(projects.id, task.projectId));
      if (project && (project.status === 'done' || project.status === 'cancelled')) {
        throw conflict(`Its project is ${project.status === 'done' ? 'done' : 'cancelled'}; reopen the project first`);
      }
    }
    const [reopened] = await ctx.tx.update(tasks)
      .set({ status: 'open', completedAt: null, completedBy: null, startedAt: null, updatedAt: new Date() })
      .where(eq(tasks.id, id)).returning();
    task = reopened!;
    await audit(ctx, 'task', id, 'reopen', { status: from }, { status: 'open' });
  }
  if (to === 'done') return completeTask(ctx, id, null);
  if (to === 'skipped') {
    if (!reason) throw badRequest('Say why it could not be done');
    return skipTask(ctx, id, reason);
  }
  const [updated] = await ctx.tx.update(tasks)
    .set({ startedAt: to === 'in_progress' ? (task.startedAt ?? new Date()) : null, updatedAt: new Date() })
    .where(eq(tasks.id, id)).returning();
  await audit(ctx, 'task', id, 'move', { stage: from }, { stage: to });
  return updated!;
}

// ---------------------------------------------------------------------------
// Assets and maintenance
// ---------------------------------------------------------------------------
export const nextDueAfter = (doneOn: string, count: number, unit: IntervalUnit): string =>
  unit === 'months' ? addMonths(doneOn, count) : addDays(doneOn, count);

/**
 * Record that a scheduled maintenance was carried out. The next due date moves on from the
 * day the work was actually done (a six-monthly service done on 15 January is next due on 15 July).
 */
export async function logMaintenance(
  ctx: Ctx,
  scheduleId: string,
  input: { doneOn: string; doneBy?: string | null; cost?: string | null; notes?: string | null; nextDueOn?: string | null },
): Promise<{ schedule: Schedule; logId: string }> {
  const { tx } = ctx;
  const [s] = await tx.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.id, scheduleId)).for('update');
  must(s, 'Maintenance schedule');
  if (!ctx.user || (s!.assigneeId !== ctx.user.id && !can(ctx.user.role, 'ops:manage'))) {
    throw forbidden('This maintenance is looked after by someone else');
  }
  if (!s!.active) throw conflict('This schedule is switched off');
  if (input.doneOn > istDate()) throw badRequest('Record the work on or after the day it was done, not before');
  if (s!.lastDoneOn && input.doneOn < s!.lastDoneOn) {
    throw conflict(`This was last done on ${formatDate(s!.lastDoneOn)}; the new entry cannot be dated before that`);
  }
  const nextDueOn = input.nextDueOn ?? nextDueAfter(input.doneOn, s!.intervalCount, s!.intervalUnit);
  if (nextDueOn <= input.doneOn) throw badRequest('The next due date must be after the day the work was done');
  const [log] = await tx.insert(maintenanceLogs).values({
    assetId: s!.assetId, scheduleId, doneOn: input.doneOn, doneBy: input.doneBy ?? ctx.user.name, cost: input.cost ?? null,
    notes: input.notes ?? null, nextDueOn, createdBy: ctx.user.id,
  }).returning({ id: maintenanceLogs.id });
  const [updated] = await tx.update(maintenanceSchedules)
    .set({ lastDoneOn: input.doneOn, nextDueOn, updatedAt: new Date() })
    .where(eq(maintenanceSchedules.id, scheduleId)).returning();
  await audit(ctx, 'maintenance_schedule', scheduleId, 'done', { nextDueOn: s!.nextDueOn, lastDoneOn: s!.lastDoneOn }, { nextDueOn, lastDoneOn: input.doneOn });
  return { schedule: updated!, logId: log!.id };
}

/** Schedules with where they stand today: overdue, due soon (inside the reminder window) or fine. */
function scheduleRows(db: DB, today: string, where: ReturnType<typeof sql>) {
  return rows(db, sql`
    select s.id, s.asset_id, a.asset_no, a.name as asset_name, a.location as asset_location, s.title, s.interval_count, s.interval_unit,
           s.next_due_on, s.last_done_on, s.assignee_id, u.name as assignee_name, s.remind_days_before, s.instructions, s.active,
           (s.next_due_on - ${today}::date)::int as days_left,
           case when not s.active then 'off'
                when s.next_due_on < ${today}::date then 'overdue'
                when s.next_due_on <= ${today}::date + s.remind_days_before then 'due_soon'
                else 'ok' end as state
      from maintenance_schedules s
      join assets a on a.id = s.asset_id
      left join users u on u.id = s.assignee_id
     where ${where}
     order by s.active desc, s.next_due_on, a.name`);
}

/**
 * A task is late once its deadline has passed and it is still open. The deadline is the due
 * date at the due time, or the end of that day when no time was set. India time.
 */
export const LATE = sql`(t.status = 'open' and (t.due_date + coalesce(t.due_time, time '23:59:59')) < (now() at time zone 'Asia/Kolkata'))`;

export const TASK_SELECT = sql`
  select t.id, t.template_id, t.scheduled_for, t.project_id, p.project_no, p.name as project_name, t.title, t.description,
         t.assignee_id, u.name as assignee_name, t.start_date, t.due_date, to_char(t.due_time, 'HH24:MI') as due_time, t.status,
         t.started_at, case when t.status <> 'open' then t.status::text when t.started_at is null then 'todo' else 'in_progress' end as stage,
         t.checklist, t.completed_at, c.name as completed_by_name, t.note, tt.frequency,
         ${LATE} as overdue,
         jsonb_array_length(t.checklist)::int as checklist_total,
         (select count(*)::int from jsonb_array_elements(t.checklist) x where (x->>'done')::boolean) as checklist_done
    from tasks t
    join users u on u.id = t.assignee_id
    left join users c on c.id = t.completed_by
    left join task_templates tt on tt.id = t.template_id
    left join projects p on p.id = t.project_id`;

export function opsRouter(db: DB) {
  const r = Router();

  // ---- task templates ------------------------------------------------------
  r.get('/templates', requirePerm('ops:read'), async (req, res) => {
    const data = await rows(db, sql`
      select t.*, u.name as assignee_name,
             (select count(*)::int from tasks k where k.template_id = t.id and k.status = 'open') as open_tasks,
             (select max(k.due_date) from tasks k where k.template_id = t.id) as last_raised_for
        from task_templates t join users u on u.id = t.assignee_id
       order by t.active desc, t.frequency, t.title`);
    sendList(req, res, data, 'task-templates');
  });

  r.post('/templates', requirePerm('ops:manage'), async (req, res) => {
    const b = zTemplate.parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      await activeUser(ctx.tx, b.assignee_id);
      const schedule = scheduleOf(b.frequency, b.weekdays, b.month_day);
      const [t] = await ctx.tx.insert(taskTemplates).values({
        title: b.title, description: b.description ?? null, frequency: b.frequency, ...schedule, assigneeId: b.assignee_id,
        checklist: b.checklist, dueTime: b.due_time ?? null, startDate: b.start_date ?? today, active: b.active ?? true,
        createdBy: ctx.user?.id ?? null,
      }).returning();
      // If today's run has already happened, today's task for this new template would otherwise wait until tomorrow.
      await createDueTasks(ctx.tx, [t!], today, today);
      await audit(ctx, 'task_template', t!.id, 'create', null, { title: b.title, frequency: b.frequency, assigneeId: b.assignee_id });
      return t!;
    });
    res.status(201).json({ data: row });
  });

  r.patch('/templates/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zPatch(zTemplate).parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      const [t] = await ctx.tx.select().from(taskTemplates).where(eq(taskTemplates.id, id)).for('update');
      must(t, 'Task template');
      const patch: Partial<typeof taskTemplates.$inferInsert> = { updatedAt: new Date() };
      if (b.assignee_id !== undefined && b.assignee_id !== t!.assigneeId) {
        await activeUser(ctx.tx, b.assignee_id);
        patch.assigneeId = b.assignee_id;
      }
      if (b.frequency !== undefined || b.weekdays !== undefined || b.month_day !== undefined) {
        const frequency = b.frequency ?? t!.frequency;
        Object.assign(patch, { frequency }, scheduleOf(frequency, b.weekdays ?? t!.weekdays, b.month_day === undefined ? t!.monthDay : b.month_day));
      }
      if (b.title !== undefined) patch.title = b.title;
      if (b.description !== undefined) patch.description = b.description;
      if (req.body.checklist !== undefined) patch.checklist = b.checklist;
      if (b.due_time !== undefined) patch.dueTime = b.due_time;
      if (b.start_date) patch.startDate = b.start_date;
      if (b.active !== undefined) patch.active = b.active;
      const [updated] = await ctx.tx.update(taskTemplates).set(patch).where(eq(taskTemplates.id, id)).returning();
      await createDueTasks(ctx.tx, [updated!], today, today);
      await audit(ctx, 'task_template', id, 'update',
        { frequency: t!.frequency, assigneeId: t!.assigneeId, active: t!.active },
        { frequency: updated!.frequency, assigneeId: updated!.assigneeId, active: updated!.active });
      return updated!;
    });
    res.json({ data: row });
  });

  /** Raise a task from a template by hand: the way need-based tasks start, and an extra run of any other. */
  r.post('/templates/:id/raise', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      due_date: emptyToNull(zDate).optional(), due_time: emptyToNull(zClock).optional(), assignee_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      const [t] = await ctx.tx.select().from(taskTemplates).where(eq(taskTemplates.id, id));
      must(t, 'Task template');
      if (!t!.active) throw conflict('This template is switched off');
      const dueDate = b.due_date ?? today;
      if (dueDate < today) throw badRequest('The deadline cannot be in the past');
      const assigneeId = b.assignee_id ?? t!.assigneeId;
      await activeUser(ctx.tx, assigneeId);
      const [task] = await ctx.tx.insert(tasks).values({
        templateId: id, scheduledFor: null, title: t!.title, description: t!.description, assigneeId, dueDate,
        dueTime: b.due_time === undefined ? t!.dueTime : b.due_time,
        checklist: t!.checklist.map((text) => ({ text, done: false })), createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'task', task!.id, 'raise', null, { templateId: id, assigneeId, dueDate });
      return task!;
    });
    res.status(201).json({ data: row });
  });

  // ---- tasks ---------------------------------------------------------------
  /** What I have to do: every open task of mine, nearest deadline first, what I closed today, and maintenance I look after that is due. */
  r.get('/my-tasks', requireAuth, async (req, res) => {
    const today = istDate();
    await ensureTasks(db, today);
    const me = req.user!.id;
    const mine = await rows(db, sql`${TASK_SELECT}
       where t.assignee_id = ${me}
         and (t.status = 'open' or (t.completed_at at time zone 'Asia/Kolkata')::date = ${today}::date)
       order by (t.status = 'open') desc, t.due_date, t.due_time nulls last, t.title`);
    const maintenance = await scheduleRows(db, today,
      sql`s.active and s.assignee_id = ${me} and s.next_due_on <= ${today}::date + s.remind_days_before`);
    res.json({ data: { today, tasks: mine, maintenance } });
  });

  r.get('/tasks', requirePerm('ops:read'), async (req, res) => {
    const q = zListQuery.extend({
      status: z.enum(TASK_STATUSES).optional(), assignee_id: zId.optional(), from: zDate.optional(), to: zDate.optional(),
      view: z.enum(['today', 'overdue', 'board']).optional(), project_id: zId.optional(),
    }).parse(req.query);
    const today = istDate();
    await ensureTasks(db, today);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`${TASK_SELECT}
       where (${q.status ?? null}::text is null or t.status::text = ${q.status ?? null})
         and (${q.assignee_id ?? null}::uuid is null or t.assignee_id = ${q.assignee_id ?? null}::uuid)
         and (${q.from ?? null}::date is null or t.due_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or t.due_date <= ${q.to ?? null}::date)
         and (${like}::text is null or t.title ilike ${like})
         and (${q.view ?? null}::text is distinct from 'today' or t.due_date = ${today}::date)
         and (${q.view ?? null}::text is distinct from 'overdue' or ${LATE})
         -- The board: everything still open, and what closed in the last fortnight.
         and (${q.view ?? null}::text is distinct from 'board' or t.status = 'open' or t.completed_at >= now() - interval '14 days')
         and (${q.project_id ?? null}::uuid is null or t.project_id = ${q.project_id ?? null}::uuid)
       order by t.due_date desc, t.due_time nulls last, t.title
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'tasks', { limit: q.limit });
  });

  /** A one-off task for someone, outside any schedule. */
  r.post('/tasks', requirePerm('ops:manage'), async (req, res) => {
    const b = z.object({
      title: zText(150), description: emptyToNull(z.string().trim().max(2000)).optional(), assignee_id: zId,
      due_date: emptyToNull(zDate).optional(), due_time: emptyToNull(zClock).optional(),
      checklist: z.array(zText(200)).max(30).prefault([]),
    }).parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      await activeUser(ctx.tx, b.assignee_id);
      const dueDate = b.due_date ?? today;
      if (dueDate < today) throw badRequest('The deadline cannot be in the past');
      const [task] = await ctx.tx.insert(tasks).values({
        title: b.title, description: b.description ?? null, assigneeId: b.assignee_id, dueDate, dueTime: b.due_time ?? null,
        checklist: b.checklist.map((text) => ({ text, done: false })), createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'task', task!.id, 'create', null, { title: b.title, assigneeId: b.assignee_id, dueDate });
      return task!;
    });
    res.status(201).json({ data: row });
  });

  r.get('/tasks/:id', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const [task] = await rows<{ assignee_id: string }>(db, sql`${TASK_SELECT} where t.id = ${id}`);
    must(task, 'Task');
    if (task!.assignee_id !== req.user!.id && !can(req.user!.role, 'ops:read')) throw forbidden('This task is assigned to someone else');
    res.json({ data: task });
  });

  /** Tick or untick one line of the checklist. */
  r.post('/tasks/:id/checklist', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ index: z.coerce.number().int().min(0), done: z.boolean() }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const task = await lockTask(ctx.tx, id);
      mustBeMine(ctx, task);
      if (task.status !== 'open') throw conflict(`This task is already ${task.status}`);
      if (b.index >= task.checklist.length) throw badRequest('No such checklist item');
      const checklist = task.checklist.map((c, i) => (i === b.index ? { ...c, done: b.done } : c));
      const [updated] = await ctx.tx.update(tasks).set({ checklist, updatedAt: new Date() }).where(eq(tasks.id, id)).returning();
      return updated!;
    });
    res.json({ data: row });
  });

  r.post('/tasks/:id/complete', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ note: emptyToNull(z.string().trim().max(1000)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => completeTask(ctx, id, b.note ?? null)) });
  });

  r.post('/tasks/:id/skip', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(1000) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => skipTask(ctx, id, b.reason)) });
  });

  /** Drag on the board: to do, in progress, done or could not do (with the reason). See moveTask. */
  r.post('/tasks/:id/move', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ to: z.enum(TASK_STAGES), reason: emptyToNull(z.string().trim().max(1000)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => moveTask(ctx, id, b.to, b.reason ?? null)) });
  });

  r.post('/tasks/:id/reopen', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const row = await inTx(db, req, async (ctx) => {
      const task = await lockTask(ctx.tx, id);
      if (task.status === 'open') throw conflict('This task is already open');
      const [updated] = await ctx.tx.update(tasks)
        .set({ status: 'open', completedAt: null, completedBy: null, startedAt: null, updatedAt: new Date() })
        .where(eq(tasks.id, id)).returning();
      await audit(ctx, 'task', id, 'reopen', { status: task.status }, { status: 'open' });
      return updated!;
    });
    res.json({ data: row });
  });

  /** Give an open task to someone else, or move its deadline. */
  r.patch('/tasks/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      assignee_id: zId.optional(), due_date: zDate.optional(), due_time: emptyToNull(zClock).optional(),
      start_date: emptyToNull(zDate).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const task = await lockTask(ctx.tx, id);
      if (task.status !== 'open') throw conflict(`This task is already ${task.status}`);
      const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
      if (b.assignee_id && b.assignee_id !== task.assigneeId) {
        await activeUser(ctx.tx, b.assignee_id);
        patch.assigneeId = b.assignee_id;
      }
      if (b.due_date && b.due_date !== task.dueDate) {
        if (b.due_date < istDate()) throw badRequest('The deadline cannot be moved into the past');
        await deadlineFitsProject(ctx.tx, task.projectId, b.due_date);
        patch.dueDate = b.due_date;
      }
      if (b.due_time !== undefined) patch.dueTime = b.due_time;
      if (b.start_date !== undefined) {
        if (b.start_date && b.start_date > (patch.dueDate ?? task.dueDate)) throw badRequest('The start date cannot be after the deadline');
        patch.startDate = b.start_date;
      }
      const [updated] = await ctx.tx.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
      await audit(ctx, 'task', id, 'update', { assigneeId: task.assigneeId, dueDate: task.dueDate }, { assigneeId: updated!.assigneeId, dueDate: updated!.dueDate });
      return updated!;
    });
    res.json({ data: row });
  });

  // ---- assets --------------------------------------------------------------
  const zAsset = z.object({
    name: zText(150), category: zText(80), location: emptyToNull(z.string().trim().max(150)).optional(),
    serial_no: emptyToNull(z.string().trim().max(100)).optional(), purchase_date: emptyToNull(zDate).optional(),
    purchase_cost: emptyToNull(zMoney).optional(), status: z.enum(ASSET_STATUSES).optional(),
    notes: emptyToNull(z.string().trim().max(2000)).optional(),
  });

  r.get('/assets', requirePerm('ops:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(ASSET_STATUSES).optional() }).parse(req.query);
    const today = istDate();
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select a.*,
             (select count(*)::int from maintenance_schedules s where s.asset_id = a.id and s.active) as schedules,
             (select min(s.next_due_on) from maintenance_schedules s where s.asset_id = a.id and s.active) as next_due_on,
             (select count(*)::int from maintenance_schedules s where s.asset_id = a.id and s.active and s.next_due_on < ${today}::date) as overdue,
             (select max(l.done_on) from maintenance_logs l where l.asset_id = a.id) as last_serviced_on,
             (select coalesce(sum(l.cost), 0)::numeric(14,2) from maintenance_logs l where l.asset_id = a.id) as maintenance_cost
        from assets a
       where (${q.status ?? null}::text is null or a.status::text = ${q.status ?? null})
         and (${like}::text is null or a.name ilike ${like} or a.asset_no ilike ${like} or a.category ilike ${like} or a.serial_no ilike ${like})
       order by (a.status = 'retired'), a.name
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'assets', { limit: q.limit });
  });

  r.get('/assets/:id', requirePerm('ops:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [asset] = await db.select().from(assets).where(eq(assets.id, id));
    must(asset, 'Asset');
    const schedules = await scheduleRows(db, istDate(), sql`s.asset_id = ${id}`);
    const logs = await rows(db, sql`
      select l.id, l.done_on, l.done_by, l.cost, l.notes, l.next_due_on, l.schedule_id, s.title as schedule_title
        from maintenance_logs l left join maintenance_schedules s on s.id = l.schedule_id
       where l.asset_id = ${id} order by l.done_on desc, l.created_at desc`);
    res.json({ data: { ...asset, schedules, logs } });
  });

  r.post('/assets', requirePerm('ops:manage'), async (req, res) => {
    const b = zAsset.parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const { number } = await nextNumber(ctx.tx, 'asset', istDate());
      const [a] = await ctx.tx.insert(assets).values({
        assetNo: number, name: b.name, category: b.category, location: b.location ?? null, serialNo: b.serial_no ?? null,
        purchaseDate: b.purchase_date ?? null, purchaseCost: b.purchase_cost ?? null, status: b.status ?? 'in_use',
        notes: b.notes ?? null, createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'asset', a!.id, 'create', null, { assetNo: number, name: b.name });
      return a!;
    });
    res.status(201).json({ data: row });
  });

  r.patch('/assets/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zPatch(zAsset).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(assets).where(eq(assets.id, id)).for('update');
      must(a, 'Asset');
      const patch: Partial<typeof assets.$inferInsert> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name;
      if (b.category !== undefined) patch.category = b.category;
      if (b.location !== undefined) patch.location = b.location;
      if (b.serial_no !== undefined) patch.serialNo = b.serial_no;
      if (b.purchase_date !== undefined) patch.purchaseDate = b.purchase_date;
      if (b.purchase_cost !== undefined) patch.purchaseCost = b.purchase_cost;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.status !== undefined && b.status !== a!.status) {
        patch.status = b.status;
        // Nothing left to maintain on a retired asset: its reminders stop.
        if (b.status === 'retired') {
          await ctx.tx.update(maintenanceSchedules).set({ active: false, updatedAt: new Date() }).where(eq(maintenanceSchedules.assetId, id));
        }
      }
      const [updated] = await ctx.tx.update(assets).set(patch).where(eq(assets.id, id)).returning();
      await audit(ctx, 'asset', id, 'update', { status: a!.status, location: a!.location }, { status: updated!.status, location: updated!.location });
      return updated!;
    });
    res.json({ data: row });
  });

  /** A repair or service that was not on any schedule (a breakdown, a one-off visit). */
  r.post('/assets/:id/logs', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      done_on: zDate, done_by: emptyToNull(z.string().trim().max(150)).optional(), cost: emptyToNull(zMoney).optional(),
      notes: zText(2000),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select({ id: assets.id }).from(assets).where(eq(assets.id, id));
      must(a, 'Asset');
      if (b.done_on > istDate()) throw badRequest('Record the work on or after the day it was done, not before');
      const [log] = await ctx.tx.insert(maintenanceLogs).values({
        assetId: id, doneOn: b.done_on, doneBy: b.done_by ?? ctx.user?.name ?? null, cost: b.cost ?? null, notes: b.notes,
        createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'asset', id, 'repair_logged', null, { doneOn: b.done_on, cost: b.cost ?? null });
      return log!;
    });
    res.status(201).json({ data: row });
  });

  // ---- maintenance schedules ----------------------------------------------
  const zSchedule = z.object({
    title: zText(150), interval_count: z.coerce.number().int().min(1).max(3650), interval_unit: z.enum(INTERVAL_UNITS),
    last_done_on: emptyToNull(zDate).optional(), next_due_on: emptyToNull(zDate).optional(), assignee_id: emptyToNull(zId).optional(),
    remind_days_before: z.coerce.number().int().min(0).max(365).prefault(7), instructions: emptyToNull(z.string().trim().max(2000)).optional(),
    active: z.boolean().optional(),
  });

  /** Everything on a schedule, most urgent first. view=due keeps only what is overdue or inside its reminder window. */
  r.get('/maintenance', requirePerm('ops:read'), async (req, res) => {
    const q = z.object({ view: z.enum(['due', 'all']).prefault('all') }).parse(req.query);
    const today = istDate();
    const data = await scheduleRows(db, today,
      q.view === 'due' ? sql`s.active and s.next_due_on <= ${today}::date + s.remind_days_before` : sql`true`);
    sendList(req, res, data, 'maintenance');
  });

  r.post('/assets/:id/schedules', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zSchedule.parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(assets).where(eq(assets.id, id));
      must(a, 'Asset');
      if (a!.status === 'retired') throw conflict('This asset is retired');
      if (b.assignee_id) await activeUser(ctx.tx, b.assignee_id);
      if (b.last_done_on && b.last_done_on > today) throw badRequest('The last service date cannot be in the future');
      // Due date: the one given, else one interval after the last service, else one interval from today.
      const nextDueOn = b.next_due_on ?? nextDueAfter(b.last_done_on ?? today, b.interval_count, b.interval_unit);
      const [s] = await ctx.tx.insert(maintenanceSchedules).values({
        assetId: id, title: b.title, intervalCount: b.interval_count, intervalUnit: b.interval_unit, nextDueOn,
        lastDoneOn: b.last_done_on ?? null, assigneeId: b.assignee_id ?? null, remindDaysBefore: b.remind_days_before,
        instructions: b.instructions ?? null, createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'maintenance_schedule', s!.id, 'create', null, { assetId: id, title: b.title, every: `${b.interval_count} ${b.interval_unit}`, nextDueOn });
      return s!;
    });
    res.status(201).json({ data: row });
  });

  r.patch('/schedules/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zPatch(zSchedule).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [s] = await ctx.tx.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.id, id)).for('update');
      must(s, 'Maintenance schedule');
      if (b.assignee_id) await activeUser(ctx.tx, b.assignee_id);
      const patch: Partial<typeof maintenanceSchedules.$inferInsert> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.interval_count !== undefined) patch.intervalCount = b.interval_count;
      if (b.interval_unit !== undefined) patch.intervalUnit = b.interval_unit;
      if (b.next_due_on) patch.nextDueOn = b.next_due_on;
      if (b.assignee_id !== undefined) patch.assigneeId = b.assignee_id;
      if (req.body.remind_days_before !== undefined) patch.remindDaysBefore = b.remind_days_before;
      if (b.instructions !== undefined) patch.instructions = b.instructions;
      if (b.active !== undefined) patch.active = b.active;
      const [updated] = await ctx.tx.update(maintenanceSchedules).set(patch).where(eq(maintenanceSchedules.id, id)).returning();
      await audit(ctx, 'maintenance_schedule', id, 'update', { nextDueOn: s!.nextDueOn, active: s!.active }, { nextDueOn: updated!.nextDueOn, active: updated!.active });
      return updated!;
    });
    res.json({ data: row });
  });

  /** The work was done: keep the record and move the next due date on. Open to whoever looks after this schedule. */
  r.post('/schedules/:id/done', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      done_on: emptyToNull(zDate).optional(), done_by: emptyToNull(z.string().trim().max(150)).optional(), cost: emptyToNull(zMoney).optional(),
      notes: emptyToNull(z.string().trim().max(2000)).optional(), next_due_on: emptyToNull(zDate).optional(),
    }).parse(req.body);
    const result = await inTx(db, req, (ctx) =>
      logMaintenance(ctx, id, { doneOn: b.done_on ?? istDate(), doneBy: b.done_by, cost: b.cost, notes: b.notes, nextDueOn: b.next_due_on }));
    res.status(201).json({ data: result.schedule });
  });

  // ---- dashboard -----------------------------------------------------------
  r.get('/dashboard', requirePerm('ops:read'), async (_req, res) => {
    const today = istDate();
    await ensureTasks(db, today);
    const since = addDays(today, -13);
    const [todayTotals] = await rows(db, sql`
      select count(*)::int as total, count(*) filter (where t.status = 'done')::int as done,
             count(*) filter (where t.status = 'open' and not ${LATE})::int as open, count(*) filter (where t.status = 'skipped')::int as skipped
        from tasks t where t.due_date = ${today}::date`);
    const [overdue] = await rows(db, sql`
      select count(*)::int as count, min(t.due_date) as oldest from tasks t where ${LATE}`);
    const byDay = await rows(db, sql`
      select t.due_date as day, count(*) filter (where t.status = 'done')::int as done,
             count(*) filter (where t.status = 'skipped')::int as skipped, count(*) filter (where t.status = 'open')::int as open
        from tasks t where t.due_date between ${since}::date and ${today}::date group by t.due_date order by t.due_date`);
    const byPerson = await rows(db, sql`
      select u.id as user_id, u.name,
             count(*) filter (where t.status = 'open' and t.due_date = ${today}::date and not ${LATE})::int as open_today,
             count(*) filter (where ${LATE})::int as overdue,
             count(*) filter (where t.status = 'done' and t.due_date >= ${addDays(today, -29)}::date)::int as done_30_days,
             count(*) filter (where t.status = 'done' and t.due_date >= ${addDays(today, -29)}::date
                                and (t.completed_at at time zone 'Asia/Kolkata') <= (t.due_date + coalesce(t.due_time, time '23:59:59')))::int as on_time_30_days,
             count(*) filter (where t.due_date between ${addDays(today, -29)}::date and ${today}::date)::int as assigned_30_days
        from tasks t join users u on u.id = t.assignee_id
       where t.due_date >= ${addDays(today, -29)}::date or t.status = 'open'
       group by u.id, u.name order by overdue desc, open_today desc, u.name`);
    const due = await scheduleRows(db, today, sql`s.active and s.next_due_on <= ${today}::date + s.remind_days_before`);
    const assetsByStatus = await rows(db, sql`select a.status, count(*)::int as count from assets a group by a.status`);
    const [spend] = await rows(db, sql`
      select coalesce(sum(l.cost), 0)::numeric(14,2) as last_12_months from maintenance_logs l where l.done_on > ${addMonths(today, -12)}::date`);
    res.json({
      data: {
        today, tasks_today: todayTotals, overdue, tasks_by_day: byDay, by_person: byPerson,
        maintenance_due: due,
        maintenance: { overdue: due.filter((d) => d.state === 'overdue').length, due_soon: due.filter((d) => d.state === 'due_soon').length },
        assets_by_status: assetsByStatus, maintenance_spend: spend,
      },
    });
  });

  return r;
}
