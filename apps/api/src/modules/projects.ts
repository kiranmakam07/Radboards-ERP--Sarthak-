import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { PROJECT_STATUSES, addDays, can, formatDate, istDate, peakLoad, weekStart, type ProjectStatus } from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { nextNumber } from '../core/numbering';
import { rows, type DB } from '../db/client';
import { allocations, assets, employees, projects, tasks } from '../db/schema';
import { badRequest, conflict, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zClock, zDate, zId, zText, type Ctx } from '../lib/http';
import { LATE, TASK_SELECT, activeUser, deadlineFitsProject } from './ops';

type Project = typeof projects.$inferSelect;

const LIVE: ProjectStatus[] = ['planned', 'active', 'on_hold'];
const words = (v: string) => v.replace(/_/g, ' ');

/** Whoever runs operations can change any project; so can the person who owns it. */
function mayRun(ctx: Ctx, project: Project): void {
  if (!ctx.user || (project.ownerId !== ctx.user.id && !can(ctx.user.role, 'ops:manage'))) {
    throw forbidden('Only the project owner or operations can change this project');
  }
}

async function lockProject(tx: DB, id: string): Promise<Project> {
  const [p] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
  return must(p, 'Project');
}

/**
 * From this day on the project needs nobody: allocations still running end today, and ones
 * that had not started yet are removed. What already happened stays on record.
 */
async function releaseResources(ctx: Ctx, projectId: string, today: string): Promise<void> {
  await ctx.tx.delete(allocations).where(and(eq(allocations.projectId, projectId), gt(allocations.fromDate, today)));
  await ctx.tx.update(allocations).set({ toDate: today, updatedAt: new Date() })
    .where(and(eq(allocations.projectId, projectId), lte(allocations.fromDate, today), gt(allocations.toDate, today)));
}

export async function setProjectStatus(ctx: Ctx, project: Project, status: ProjectStatus): Promise<Partial<typeof projects.$inferInsert>> {
  const today = istDate();
  if (status === 'done') {
    const [open] = await rows<{ n: number }>(ctx.tx, sql`select count(*)::int as n from tasks where project_id = ${project.id} and status = 'open'`);
    if (open!.n > 0) throw conflict(`${open!.n} task(s) in this project are still open. Finish them, or mark them as not done, first.`, { openTasks: open!.n });
    await releaseResources(ctx, project.id, today);
    return { status, completedOn: today };
  }
  if (status === 'cancelled') {
    // Cancelling the project closes whatever was still to be done in it.
    await ctx.tx.update(tasks)
      .set({ status: 'skipped', completedAt: new Date(), completedBy: ctx.user?.id ?? null, note: 'Project cancelled', updatedAt: new Date() })
      .where(and(eq(tasks.projectId, project.id), eq(tasks.status, 'open')));
    await releaseResources(ctx, project.id, today);
  }
  return { status, completedOn: null };
}

// ---------------------------------------------------------------------------
// Resource allocation
// ---------------------------------------------------------------------------
type Resource = { employeeId: string | null; assetId: string | null };

async function resourceName(tx: DB, r: Resource): Promise<string> {
  if (r.employeeId) {
    const [e] = await tx.select({ name: employees.name, status: employees.status }).from(employees).where(eq(employees.id, r.employeeId));
    if (!e) throw badRequest('Unknown employee');
    if (e.status !== 'active') throw conflict(`${e.name} has left and cannot be allocated`);
    return e.name;
  }
  const [a] = await tx.select({ name: assets.name, status: assets.status }).from(assets).where(eq(assets.id, r.assetId!));
  if (!a) throw badRequest('Unknown asset');
  if (a.status === 'retired') throw conflict(`${a.name} is retired and cannot be allocated`);
  return a.name;
}

/**
 * A person or machine cannot be promised for more than all of their time. If this allocation
 * would take them past 100% on any day, it is refused with the list of what it clashes with,
 * unless the caller says to go ahead anyway.
 */
async function checkLoad(
  tx: DB, r: Resource, span: { from: string; to: string; percent: number }, exceptId: string | null, allowOver: boolean,
): Promise<number> {
  const who = r.employeeId ? sql`a.employee_id = ${r.employeeId}` : sql`a.asset_id = ${r.assetId}`;
  const others = await rows<{ id: string; from_date: string; to_date: string; percent: number; work: string }>(tx, sql`
    select a.id, a.from_date, a.to_date, a.percent, coalesce(p.name, a.label) as work
      from allocations a left join projects p on p.id = a.project_id
     where ${who} and a.to_date >= ${span.from}::date and a.from_date <= ${span.to}::date
       and (${exceptId}::uuid is null or a.id <> ${exceptId}::uuid)
     order by a.from_date, a.created_at`);
  const peak = peakLoad([...others.map((o) => ({ from: o.from_date, to: o.to_date, percent: o.percent })), span], span.from, span.to);
  if (peak > 100 && !allowOver) {
    const name = await resourceName(tx, r);
    throw conflict(`${name} would be committed for ${peak}% of their time in that period`, {
      peak,
      clashes: others.map((o) => ({ work: o.work, percent: o.percent, from: o.from_date, to: o.to_date })),
    });
  }
  return peak;
}

const zAllocation = z.object({
  project_id: emptyToNull(zId).optional(),
  label: emptyToNull(z.string().trim().max(150)).optional(),
  employee_id: emptyToNull(zId).optional(),
  asset_id: emptyToNull(zId).optional(),
  from_date: zDate,
  to_date: zDate,
  percent: z.coerce.number().int().min(1).max(100).default(100),
  role: emptyToNull(z.string().trim().max(150)).optional(),
  notes: emptyToNull(z.string().trim().max(1000)).optional(),
  allow_over: z.boolean().optional(),
});

const ALLOCATION_SELECT = sql`
  select a.id, a.project_id, p.project_no, p.name as project_name, a.label, coalesce(p.name, a.label) as work,
         a.employee_id, e.employee_no, e.name as employee_name, e.department, a.asset_id, s.asset_no, s.name as asset_name,
         coalesce(e.name, s.name) as resource_name, a.from_date, a.to_date, a.percent, a.role, a.notes
    from allocations a
    left join projects p on p.id = a.project_id
    left join employees e on e.id = a.employee_id
    left join assets s on s.id = a.asset_id`;

export function projectsRouter(db: DB) {
  const r = Router();

  /** The people who can be allocated: everyone on the rolls. Names and roles only; pay stays in HR. */
  r.get('/people', requirePerm('ops:read'), async (_req, res) => {
    const data = await rows(db, sql`
      select e.id, e.employee_no, e.name, e.department, e.designation, e.user_id
        from employees e where e.status = 'active' order by e.department, e.name`);
    res.json({ data });
  });

  // ---- projects ------------------------------------------------------------
  r.get('/projects', requirePerm('ops:read'), async (req, res) => {
    const q = z.object({ status: z.enum(PROJECT_STATUSES).optional(), view: z.enum(['live']).optional() }).parse(req.query);
    const today = istDate();
    const data = await rows(db, sql`
      select p.*, u.name as owner_name,
             (select count(*)::int from tasks t where t.project_id = p.id and t.status <> 'skipped') as tasks,
             (select count(*)::int from tasks t where t.project_id = p.id and t.status = 'done') as tasks_done,
             (select count(*)::int from tasks t where t.project_id = p.id and t.status = 'open') as tasks_open,
             (select count(*)::int from tasks t where t.project_id = p.id and ${LATE}) as tasks_late,
             (select count(distinct a.employee_id)::int from allocations a where a.project_id = p.id) as people,
             (p.deadline - ${today}::date)::int as days_left,
             (p.status in ('planned','active','on_hold') and p.deadline < ${today}::date) as overdue
        from projects p join users u on u.id = p.owner_id
       where (${q.status ?? null}::text is null or p.status::text = ${q.status ?? null})
         and (${q.view ?? null}::text is null or p.status in ('planned','active','on_hold'))
       order by (p.status in ('planned','active','on_hold')) desc, p.deadline nulls last, p.created_at desc`);
    sendList(req, res, data, 'projects');
  });

  r.post('/projects', requirePerm('ops:manage'), async (req, res) => {
    const b = z.object({
      name: zText(150), description: emptyToNull(z.string().trim().max(4000)).optional(), owner_id: zId,
      start_date: emptyToNull(zDate).optional(), deadline: emptyToNull(zDate).optional(),
      status: z.enum(['planned', 'active']).default('planned'),
    }).parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      await activeUser(ctx.tx, b.owner_id);
      const startDate = b.start_date ?? today;
      if (b.deadline && b.deadline < startDate) throw badRequest('The deadline cannot be before the start date');
      const { number } = await nextNumber(ctx.tx, 'project', today);
      const [p] = await ctx.tx.insert(projects).values({
        projectNo: number, name: b.name, description: b.description ?? null, ownerId: b.owner_id, startDate,
        deadline: b.deadline ?? null, status: b.status, createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'project', p!.id, 'create', null, { projectNo: number, name: b.name, ownerId: b.owner_id, deadline: b.deadline ?? null });
      return p!;
    });
    res.status(201).json({ data: row });
  });

  /** One project with its tasks and who is allocated to it. Open to operations and to the project's owner. */
  r.get('/projects/:id', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const today = istDate();
    const [p] = await rows<{ owner_id: string }>(db, sql`
      select p.*, u.name as owner_name, (p.deadline - ${today}::date)::int as days_left,
             (p.status in ('planned','active','on_hold') and p.deadline < ${today}::date) as overdue
        from projects p join users u on u.id = p.owner_id where p.id = ${id}`);
    must(p, 'Project');
    if (p!.owner_id !== req.user!.id && !can(req.user!.role, 'ops:read')) throw forbidden();
    const list = await rows(db, sql`${TASK_SELECT} where t.project_id = ${id} order by t.due_date, t.due_time nulls last, t.title`);
    const team = await rows(db, sql`${ALLOCATION_SELECT} where a.project_id = ${id} order by a.from_date, resource_name`);
    res.json({ data: { ...p, tasks: list, allocations: team, can_manage: p!.owner_id === req.user!.id || can(req.user!.role, 'ops:manage') } });
  });

  r.patch('/projects/:id', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      name: zText(150).optional(), description: emptyToNull(z.string().trim().max(4000)).optional(), owner_id: zId.optional(),
      start_date: zDate.optional(), deadline: emptyToNull(zDate).optional(), status: z.enum(PROJECT_STATUSES).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const p = await lockProject(ctx.tx, id);
      mayRun(ctx, p);
      const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name;
      if (b.description !== undefined) patch.description = b.description;
      if (b.owner_id !== undefined && b.owner_id !== p.ownerId) {
        await activeUser(ctx.tx, b.owner_id);
        patch.ownerId = b.owner_id;
      }
      const startDate = b.start_date ?? p.startDate;
      const deadline = b.deadline === undefined ? p.deadline : b.deadline;
      if (deadline && deadline < startDate) throw badRequest('The deadline cannot be before the start date');
      if (deadline && deadline !== p.deadline) {
        const [later] = await rows<{ n: number }>(ctx.tx, sql`
          select count(*)::int as n from tasks where project_id = ${id} and status = 'open' and due_date > ${deadline}::date`);
        if (later!.n > 0) throw conflict(`${later!.n} open task(s) are due after ${formatDate(deadline)}. Move those first.`);
      }
      patch.startDate = startDate;
      patch.deadline = deadline;
      if (b.status !== undefined && b.status !== p.status) Object.assign(patch, await setProjectStatus(ctx, p, b.status));
      const [updated] = await ctx.tx.update(projects).set(patch).where(eq(projects.id, id)).returning();
      await audit(ctx, 'project', id, 'update', { status: p.status, deadline: p.deadline, ownerId: p.ownerId }, { status: updated!.status, deadline: updated!.deadline, ownerId: updated!.ownerId });
      return updated!;
    });
    res.json({ data: row });
  });

  /** Add a task to the project: who, by when, and optionally from when and with which checklist. */
  r.post('/projects/:id/tasks', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      title: zText(150), description: emptyToNull(z.string().trim().max(2000)).optional(), assignee_id: zId,
      start_date: emptyToNull(zDate).optional(), due_date: zDate, due_time: emptyToNull(zClock).optional(),
      checklist: z.array(zText(200)).max(30).default([]),
    }).parse(req.body);
    const today = istDate();
    const row = await inTx(db, req, async (ctx) => {
      const p = await lockProject(ctx.tx, id);
      mayRun(ctx, p);
      if (!LIVE.includes(p.status)) throw conflict(`This project is ${words(p.status)}; reopen it before adding tasks`);
      await activeUser(ctx.tx, b.assignee_id);
      if (b.due_date < today) throw badRequest('The deadline cannot be in the past');
      if (b.start_date && b.start_date > b.due_date) throw badRequest('The start date cannot be after the deadline');
      await deadlineFitsProject(ctx.tx, id, b.due_date);
      const [task] = await ctx.tx.insert(tasks).values({
        projectId: id, title: b.title, description: b.description ?? null, assigneeId: b.assignee_id, startDate: b.start_date ?? null,
        dueDate: b.due_date, dueTime: b.due_time ?? null, checklist: b.checklist.map((text) => ({ text, done: false })),
        createdBy: ctx.user?.id ?? null,
      }).returning();
      // The first task on a planned project means the work has begun.
      if (p.status === 'planned') await ctx.tx.update(projects).set({ status: 'active', updatedAt: new Date() }).where(eq(projects.id, id));
      await audit(ctx, 'task', task!.id, 'create', null, { projectId: id, title: b.title, assigneeId: b.assignee_id, dueDate: b.due_date });
      return task!;
    });
    res.status(201).json({ data: row });
  });

  // ---- resource allocation -------------------------------------------------
  r.get('/allocations', requirePerm('ops:read'), async (req, res) => {
    const q = z.object({
      from: zDate.optional(), to: zDate.optional(), project_id: zId.optional(), employee_id: zId.optional(), asset_id: zId.optional(),
    }).parse(req.query);
    const data = await rows(db, sql`${ALLOCATION_SELECT}
       where (${q.from ?? null}::date is null or a.to_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or a.from_date <= ${q.to ?? null}::date)
         and (${q.project_id ?? null}::uuid is null or a.project_id = ${q.project_id ?? null}::uuid)
         and (${q.employee_id ?? null}::uuid is null or a.employee_id = ${q.employee_id ?? null}::uuid)
         and (${q.asset_id ?? null}::uuid is null or a.asset_id = ${q.asset_id ?? null}::uuid)
       order by a.from_date, resource_name limit 2000`);
    sendList(req, res, data, 'allocations');
  });

  r.post('/allocations', requirePerm('ops:manage'), async (req, res) => {
    const b = zAllocation.parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      if (Boolean(b.employee_id) === Boolean(b.asset_id)) throw badRequest('Pick one person or one asset to allocate');
      if (!b.project_id && !b.label) throw badRequest('Pick the project, or say what the work is');
      if (b.to_date < b.from_date) throw badRequest('The end date cannot be before the start date');
      const resource: Resource = { employeeId: b.employee_id ?? null, assetId: b.asset_id ?? null };
      await resourceName(ctx.tx, resource);
      if (b.project_id) {
        const [p] = await ctx.tx.select().from(projects).where(eq(projects.id, b.project_id));
        if (!p) throw badRequest('Unknown project');
        if (!LIVE.includes(p.status)) throw conflict(`"${p.name}" is ${words(p.status)}; nobody can be allocated to it`);
      }
      const peak = await checkLoad(ctx.tx, resource, { from: b.from_date, to: b.to_date, percent: b.percent }, null, b.allow_over ?? false);
      const [a] = await ctx.tx.insert(allocations).values({
        projectId: b.project_id ?? null, label: b.project_id ? null : b.label, employeeId: resource.employeeId, assetId: resource.assetId,
        fromDate: b.from_date, toDate: b.to_date, percent: b.percent, role: b.role ?? null, notes: b.notes ?? null,
        createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'allocation', a!.id, 'create', null, { ...resource, projectId: b.project_id ?? null, label: b.label ?? null, from: b.from_date, to: b.to_date, percent: b.percent, peak });
      return { ...a!, peak };
    });
    res.status(201).json({ data: row });
  });

  r.patch('/allocations/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      from_date: zDate.optional(), to_date: zDate.optional(), percent: z.coerce.number().int().min(1).max(100).optional(),
      role: emptyToNull(z.string().trim().max(150)).optional(), notes: emptyToNull(z.string().trim().max(1000)).optional(),
      allow_over: z.boolean().optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(allocations).where(eq(allocations.id, id)).for('update');
      must(a, 'Allocation');
      const next = { from: b.from_date ?? a!.fromDate, to: b.to_date ?? a!.toDate, percent: b.percent ?? a!.percent };
      if (next.to < next.from) throw badRequest('The end date cannot be before the start date');
      await checkLoad(ctx.tx, { employeeId: a!.employeeId, assetId: a!.assetId }, next, id, b.allow_over ?? false);
      const patch: Partial<typeof allocations.$inferInsert> = { fromDate: next.from, toDate: next.to, percent: next.percent, updatedAt: new Date() };
      if (b.role !== undefined) patch.role = b.role;
      if (b.notes !== undefined) patch.notes = b.notes;
      const [updated] = await ctx.tx.update(allocations).set(patch).where(eq(allocations.id, id)).returning();
      await audit(ctx, 'allocation', id, 'update', { from: a!.fromDate, to: a!.toDate, percent: a!.percent }, next);
      return updated!;
    });
    res.json({ data: row });
  });

  /** Take an allocation off the plan. What it was is kept in the audit trail. */
  r.delete('/allocations/:id', requirePerm('ops:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(allocations).where(eq(allocations.id, id)).for('update');
      must(a, 'Allocation');
      await ctx.tx.delete(allocations).where(eq(allocations.id, id));
      await audit(ctx, 'allocation', id, 'remove', a, null);
    });
    res.json({ ok: true });
  });

  /**
   * The resource allocation board: every person and every asset, week by week, with how much
   * of their time is already promised. The figure for a week is its busiest day, so a clash on
   * a single day still shows.
   */
  r.get('/resources', requirePerm('ops:read'), async (req, res) => {
    const q = z.object({ from: zDate.optional(), weeks: z.coerce.number().int().min(1).max(26).default(8) }).parse(req.query);
    const today = istDate();
    const from = weekStart(q.from ?? today);
    const weeks = Array.from({ length: q.weeks }, (_, i) => ({ start: addDays(from, i * 7), end: addDays(from, i * 7 + 6) }));
    const to = weeks.at(-1)!.end;
    const all = await rows<{ employee_id: string | null; asset_id: string | null; from_date: string; to_date: string; percent: number }>(db, sql`
      ${ALLOCATION_SELECT} where a.to_date >= ${from}::date and a.from_date <= ${to}::date order by a.from_date`);
    const load = (mine: typeof all) =>
      weeks.map((w) => peakLoad(mine.map((a) => ({ from: a.from_date, to: a.to_date, percent: a.percent })), w.start, w.end));

    const staff = await rows<{ id: string }>(db, sql`
      select e.id, e.employee_no, e.name, e.department, e.designation, e.user_id,
             (select count(*)::int from tasks t where t.assignee_id = e.user_id and t.status = 'open') as open_tasks,
             (select count(*)::int from tasks t where t.assignee_id = e.user_id and ${LATE}) as late_tasks
        from employees e where e.status = 'active' order by e.department, e.name`);
    const machines = await rows<{ id: string }>(db, sql`
      select s.id, s.asset_no, s.name, s.category, s.location, s.status from assets s where s.status <> 'retired' order by s.name`);

    const people = staff.map((e) => {
      const mine = all.filter((a) => a.employee_id === e.id);
      return { ...e, load: load(mine), allocations: mine };
    });
    const assetRows = machines.map((s) => {
      const mine = all.filter((a) => a.asset_id === s.id);
      return { ...s, load: load(mine), allocations: mine };
    });
    res.json({ data: { today, from, to, weeks, people, assets: assetRows } });
  });

  return r;
}
