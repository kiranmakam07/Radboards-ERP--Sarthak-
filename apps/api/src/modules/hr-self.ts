import { and, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { addDays, distanceMetres, formatDate, fyOf, fyRange, istClock, istDate, leaveEntitlement, workingDates } from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { attendance, employees, leaveRequests } from '../db/schema';
import { AppError, badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, zDate, zId, zText, type Ctx } from '../lib/http';

/**
 * What a person does for themselves, from their own phone: clock in and out (with where they
 * were), see their leave, and ask for leave. And what HR does with it: approve or refuse the
 * leave, and set the rules the register is judged by (when the day starts, the weekly off, where
 * the workplace is). Approved leave goes into the attendance register by itself.
 */

type Employee = typeof employees.$inferSelect;
type Place = { lat: number; lng: number };

const zPlace = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
}).nullish();

/** The employee record behind this sign-in. People without one (an outside accountant, say) have no attendance of their own. */
async function myEmployee(tx: DB, userId: string): Promise<Employee> {
  const [e] = await tx.select().from(employees).where(and(eq(employees.userId, userId), eq(employees.status, 'active')));
  if (!e) throw new AppError(404, 'not_linked', 'Your sign-in is not linked to an employee record, so there is no attendance to mark. HR can link it on your employee page.');
  return e;
}

const awayFrom = async (tx: DB, at: Place | null | undefined) => {
  const { place } = await getSetting(tx, 'attendance_rules');
  return place && at ? Math.round(distanceMetres(place, at)) : null;
};

/** Start my day. Where I am is kept if the phone gives it, with how far that is from the workplace. */
export async function clockIn(ctx: Ctx, at: Place | null | undefined) {
  const { tx } = ctx;
  const me = await myEmployee(tx, ctx.user!.id);
  const today = istDate();
  // One at a time per person and day, so two taps cannot both clock in.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${me.id}:${today}`}, 0))`);
  const [row] = await tx.select().from(attendance).where(and(eq(attendance.employeeId, me.id), eq(attendance.date, today)));
  if (row?.checkIn) throw conflict(`You already clocked in today at ${row.checkIn.slice(0, 5)}`);
  const values = {
    status: 'present' as const, checkIn: istClock(), selfMarked: true, inLat: at ? at.lat.toFixed(6) : null, inLng: at ? at.lng.toFixed(6) : null,
    inDistanceM: await awayFrom(tx, at), updatedAt: new Date(),
  };
  // A day HR had already marked (absent, or leave that was not taken after all) becomes a day worked.
  if (row) await tx.update(attendance).set(values).where(eq(attendance.id, row.id));
  else await tx.insert(attendance).values({ ...values, employeeId: me.id, date: today, createdBy: ctx.user!.id });
  await audit(ctx, 'attendance', `${me.id}:${today}`, 'clock_in', row ? { status: row.status } : null, { check_in: values.checkIn, distance_m: values.inDistanceM });
  return today;
}

/** End my day. Needs a clock-in today, and can be done once. */
export async function clockOut(ctx: Ctx, at: Place | null | undefined) {
  const { tx } = ctx;
  const me = await myEmployee(tx, ctx.user!.id);
  const today = istDate();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${me.id}:${today}`}, 0))`);
  const [row] = await tx.select().from(attendance).where(and(eq(attendance.employeeId, me.id), eq(attendance.date, today)));
  if (!row?.checkIn) throw conflict('You have not clocked in today');
  if (row.checkOut) throw conflict(`You already clocked out today at ${row.checkOut.slice(0, 5)}`);
  const now = istClock();
  if (now <= row.checkIn) throw conflict('You clocked in only a moment ago');
  await tx.update(attendance).set({
    checkOut: now, outLat: at ? at.lat.toFixed(6) : null, outLng: at ? at.lng.toFixed(6) : null, outDistanceM: await awayFrom(tx, at), updatedAt: new Date(),
  }).where(eq(attendance.id, row.id));
  await audit(ctx, 'attendance', `${me.id}:${today}`, 'clock_out', null, { check_out: now });
  return today;
}

/** Ask for leave between two dates. It waits for HR to approve or refuse; nothing is in the register until then. */
export async function askForLeave(ctx: Ctx, input: { from: string; to: string; reason: string }) {
  const { tx } = ctx;
  const me = await myEmployee(tx, ctx.user!.id);
  const today = istDate();
  if (input.to < input.from) throw badRequest('The last day of leave is before the first');
  if (input.from < me.joinDate) throw badRequest(`You joined on ${formatDate(me.joinDate)}; leave cannot start before that`);
  if (input.from < addDays(today, -30)) throw badRequest('Leave from more than 30 days ago is entered by HR in the register');
  if (input.to > addDays(input.from, 59)) throw badRequest('That is more than 60 days in one go. Ask for it in parts.');
  const { weekly_off: weeklyOff } = await getSetting(tx, 'attendance_rules');
  const days = workingDates(input.from, input.to, weeklyOff).length;
  if (days === 0) throw badRequest('Those days are all weekly offs, so there is no leave to take');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`leave:${me.id}`}, 0))`);
  const [clash] = await tx.select().from(leaveRequests).where(and(
    eq(leaveRequests.employeeId, me.id), inArray(leaveRequests.status, ['pending', 'approved']),
    sql`${leaveRequests.fromDate} <= ${input.to}::date and ${leaveRequests.toDate} >= ${input.from}::date`));
  if (clash) throw conflict(`You already have leave ${clash.status === 'approved' ? 'approved' : 'asked for'} from ${formatDate(clash.fromDate)} to ${formatDate(clash.toDate)}`);
  const [row] = await tx.insert(leaveRequests).values({ employeeId: me.id, fromDate: input.from, toDate: input.to, days, reason: input.reason, createdBy: ctx.user!.id }).returning();
  await audit(ctx, 'leave_request', row!.id, 'create', null, row);
  return row!;
}

/** Approve or refuse. Approving writes Leave into the register for each working day of the span. */
export async function decideLeave(ctx: Ctx, id: string, approve: boolean, note: string | null) {
  const { tx } = ctx;
  const [req] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id)).for('update');
  must(req, 'Leave request');
  if (req!.status !== 'pending') throw conflict(`This request was already ${req!.status}`);
  if (!approve && !note) throw badRequest('Say why it is refused, so the person knows');
  const [row] = await tx.update(leaveRequests)
    .set({ status: approve ? 'approved' : 'rejected', decidedBy: ctx.user!.id, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() })
    .where(eq(leaveRequests.id, id)).returning();
  if (approve) {
    const { weekly_off: weeklyOff } = await getSetting(tx, 'attendance_rules');
    const days = workingDates(req!.fromDate, req!.toDate, weeklyOff);
    if (days.length > 0) {
      await tx.insert(attendance)
        .values(days.map((date) => ({ employeeId: req!.employeeId, date, status: 'leave' as const, note: `Leave approved: ${req!.reason}`.slice(0, 300), createdBy: ctx.user!.id })))
        // A day the person actually worked stays as it is; a day marked absent becomes leave.
        .onConflictDoUpdate({
          target: [attendance.employeeId, attendance.date],
          set: { status: sql`excluded.status`, note: sql`excluded.note`, updatedAt: new Date() },
          setWhere: sql`${attendance.status} in ('absent', 'leave') and ${attendance.checkIn} is null`,
        });
    }
  }
  await audit(ctx, 'leave_request', id, approve ? 'approve' : 'reject', { status: 'pending' }, { status: row!.status, note });
  return row!;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function hrSelfRouter(db: DB) {
  const r = Router();

  /** Everything the "My attendance" card shows: today, the last fortnight, leave left, and what has been asked for. */
  r.get('/me', requireAuth, async (req, res) => {
    const [me] = await db.select().from(employees).where(and(eq(employees.userId, req.user!.id), eq(employees.status, 'active')));
    if (!me) return void res.json({ data: null });
    const today = istDate();
    const rules = await getSetting(db, 'attendance_rules');
    const days = await rows<Record<string, any>>(db, sql`
      select a.date, a.status, to_char(a.check_in, 'HH24:MI') as check_in, to_char(a.check_out, 'HH24:MI') as check_out, a.self_marked,
             a.in_distance_m, a.out_distance_m, (a.in_lat is null and a.self_marked) as no_location
        from attendance a where a.employee_id = ${me.id} and a.date between ${addDays(today, -13)}::date and ${today}::date order by a.date desc`);
    const year = fyRange(fyOf(today));
    const [taken] = await rows<{ n: number }>(db, sql`
      select count(*)::int as n from attendance where employee_id = ${me.id} and status = 'leave' and date between ${year.from}::date and ${year.to}::date`);
    const entitled = leaveEntitlement(me.annualLeaveDays === null ? await getSetting(db, 'annual_leave_days') : Number(me.annualLeaveDays), me.joinDate, year);
    const requests = await rows(db, sql`
      select r.id, r.from_date, r.to_date, r.days, r.reason, r.status, r.decision_note, r.decided_at, u.name as decided_by, r.created_at
        from leave_requests r left join users u on u.id = r.decided_by where r.employee_id = ${me.id} order by r.created_at desc limit 10`);
    res.json({
      data: {
        employee: { id: me.id, employee_no: me.employeeNo, name: me.name, department: me.department },
        today, today_row: days.find((d) => String(d.date).slice(0, 10) === today) ?? null, days,
        place: rules.place ? { name: rules.place.name, radius_m: rules.place.radius_m } : null,
        leave: { entitled, taken: taken!.n, left: entitled - taken!.n },
        requests,
      },
    });
  });

  r.post('/me/clock-in', requireAuth, async (req, res) => {
    const b = z.object({ at: zPlace }).parse(req.body ?? {});
    res.status(201).json({ data: { date: await inTx(db, req, (ctx) => clockIn(ctx, b.at)) } });
  });

  r.post('/me/clock-out', requireAuth, async (req, res) => {
    const b = z.object({ at: zPlace }).parse(req.body ?? {});
    res.json({ data: { date: await inTx(db, req, (ctx) => clockOut(ctx, b.at)) } });
  });

  r.post('/me/leave', requireAuth, async (req, res) => {
    const b = z.object({ from: zDate, to: zDate, reason: zText(300) }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => askForLeave(ctx, b)) });
  });

  /** Take back a request nobody has decided yet. */
  r.post('/me/leave/:id/cancel', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const me = await myEmployee(ctx.tx, ctx.user!.id);
      const [row] = await ctx.tx.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.employeeId, me.id))).for('update');
      must(row, 'Leave request');
      if (row!.status !== 'pending') throw conflict(`This request was already ${row!.status}. Speak to HR to change it.`);
      await ctx.tx.update(leaveRequests).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(leaveRequests.id, id));
      await audit(ctx, 'leave_request', id, 'cancel', { status: 'pending' }, { status: 'cancelled' });
    });
    res.json({ ok: true });
  });

  r.get('/leave-requests', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }).parse(req.query);
    const year = fyRange(fyOf(istDate()));
    res.json({ data: await rows(db, sql`
      select r.id, r.employee_id, e.name, e.employee_no, e.department, r.from_date, r.to_date, r.days, r.reason, r.status, r.decision_note,
             r.decided_at, u.name as decided_by, r.created_at,
             (select count(*)::int from attendance a where a.employee_id = e.id and a.status = 'leave' and a.date between ${year.from}::date and ${year.to}::date) as taken_this_year
        from leave_requests r join employees e on e.id = r.employee_id left join users u on u.id = r.decided_by
       where (${q.status ?? null}::text is null or r.status::text = ${q.status ?? null})
       order by (r.status = 'pending') desc, r.created_at desc limit 200`) });
  });

  r.post('/leave-requests/:id/decide', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ approve: z.boolean(), note: emptyToNull(z.string().trim().max(300)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => decideLeave(ctx, id, b.approve, b.note ?? null)) });
  });

  r.get('/attendance-rules', requirePerm('hr:read'), async (_req, res) => {
    res.json({ data: await getSetting(db, 'attendance_rules') });
  });

  r.put('/attendance-rules', requirePerm('hr:write'), async (req, res) => {
    const b = z.object({
      start: emptyToNull(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 10:00')).nullish(),
      grace_min: z.coerce.number().int().min(0).max(240),
      weekly_off: z.array(z.number().int().min(0).max(6)).max(6),
      place: z.object({
        name: zText(80), lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius_m: z.coerce.number().int().min(20).max(50_000),
      }).nullable(),
    }).parse(req.body);
    const next = { start: b.start ?? null, grace_min: b.grace_min, weekly_off: [...new Set(b.weekly_off)].sort(), place: b.place };
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'attendance_rules');
      await setSetting(ctx.tx, 'attendance_rules', next, ctx.user!.id);
      await audit(ctx, 'settings', 'attendance_rules', 'update', before, next);
    });
    res.json({ data: next });
  });

  return r;
}
