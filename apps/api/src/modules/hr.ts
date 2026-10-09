import { and, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  APPLICANT_SOURCES, APPLICANT_STAGES, APPLICANT_STAGE_LABELS, ATTENDANCE_STATUSES, EMPLOYMENT_TYPES, INTERVIEW_MODES,
  INTERVIEW_RESULTS, OPENING_STATUSES, OPEN_APPLICANT_STAGES, REJECT_REASONS, can, canMoveApplicant, formatDate, istDate,
  fyOf, fyRange, lastDayOfMonth, leaveEntitlement, normalisePhone, type ApplicantStage, type AttendanceStatus, type RejectReason,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { nextNumber } from '../core/numbering';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { applicantActivities, applicants, attendance, employees, interviews, jobOpenings, users } from '../db/schema';
import { parseBankDate, parseCsv } from '../lib/bank-csv';
import { badRequest, conflict, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zClock, zDate, zLink, zId, zListQuery, zMoney, zPhone, zText, wantsFile, type Ctx } from '../lib/http';

export type Applicant = typeof applicants.$inferSelect;
export type Employee = typeof employees.$inferSelect;
type Interview = typeof interviews.$inferSelect;

const words = (v: string) => v.replace(/_/g, ' ');
const zWhen = z.coerce.date();
const zYears = z.coerce.number().min(0).max(60).transform((n) => n.toFixed(1));
const zLeaveDays = z.coerce.number().min(0).max(365).transform((n) => n.toFixed(1));
const when = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function note(ctx: Ctx, applicantId: string, type: 'note' | 'call' | 'stage_change' | 'interview', text: string | null) {
  return ctx.tx.insert(applicantActivities).values({ applicantId, type, note: text, userId: ctx.user?.id ?? null });
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
export type EmployeeInput = {
  name: string; phone: string; email?: string | null; department: string; designation: string;
  employmentType?: (typeof EMPLOYMENT_TYPES)[number]; joinDate: string; monthlySalary?: string | null;
  userId?: string | null; notes?: string | null; annualLeaveDays?: string | null;
};

async function checkSignIn(tx: DB, userId: string, exceptEmployeeId: string | null): Promise<void> {
  const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!u) throw badRequest('That sign-in does not exist');
  const [taken] = await tx.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.userId, userId));
  if (taken && taken.id !== exceptEmployeeId) throw conflict(`That sign-in already belongs to ${taken.name}`);
}

async function checkNotOnRolls(tx: DB, phone: string, exceptEmployeeId: string | null): Promise<void> {
  const [same] = await tx
    .select({ id: employees.id, name: employees.name, employeeNo: employees.employeeNo })
    .from(employees)
    .where(and(eq(employees.phone, phone), eq(employees.status, 'active')));
  if (same && same.id !== exceptEmployeeId) throw conflict(`${same.name} (${same.employeeNo}) is already on the rolls with this phone number`);
}

export async function createEmployee(ctx: Ctx, input: EmployeeInput): Promise<Employee> {
  const { tx } = ctx;
  await checkNotOnRolls(tx, input.phone, null);
  if (input.userId) await checkSignIn(tx, input.userId, null);
  const { number } = await nextNumber(tx, 'employee', istDate());
  const [row] = await tx
    .insert(employees)
    .values({
      employeeNo: number, name: input.name, phone: input.phone, email: input.email ?? null, department: input.department,
      designation: input.designation, employmentType: input.employmentType ?? 'full_time', joinDate: input.joinDate,
      monthlySalary: input.monthlySalary ?? null, userId: input.userId ?? null, notes: input.notes ?? null,
      annualLeaveDays: input.annualLeaveDays ?? null, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await audit(ctx, 'employee', row!.id, 'create', null, {
    employeeNo: number, name: input.name, department: input.department, designation: input.designation, joinDate: input.joinDate,
    monthlySalary: input.monthlySalary ?? null,
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Applicants: applied -> shortlisted -> interview -> offered -> hired / rejected
// ---------------------------------------------------------------------------
export type ApplicantInput = {
  name: string; phone: string; email?: string | null; openingId?: string | null; source: (typeof APPLICANT_SOURCES)[number];
  sourceDetail?: string | null; resumeUrl?: string | null; experienceYears?: string | null; currentCompany?: string | null;
  expectedSalary?: string | null; ownerId?: string | null; appliedOn?: string | null; notes?: string | null;
};

async function openApplicationFor(tx: DB, phone: string, exceptId: string | null) {
  const [open] = await tx
    .select({ id: applicants.id, name: applicants.name, applicantNo: applicants.applicantNo, stage: applicants.stage })
    .from(applicants)
    .where(and(eq(applicants.phone, phone), inArray(applicants.stage, OPEN_APPLICANT_STAGES)));
  if (open && open.id !== exceptId) {
    throw conflict(
      `${open.name} already has an application in progress (${open.applicantNo}, ${APPLICANT_STAGE_LABELS[open.stage]})`,
      { applicantId: open.id, applicantNo: open.applicantNo },
    );
  }
}

async function openingTakingApplications(tx: DB, openingId: string) {
  const [o] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, openingId));
  if (!o) throw badRequest('Unknown opening');
  if (o.status !== 'open') throw conflict(`The opening "${o.title}" is ${words(o.status)} and is not taking applications`);
  return o;
}

/** Every resume lands here. A person with an application already in progress is not entered twice. */
export async function createApplicant(ctx: Ctx, input: ApplicantInput): Promise<Applicant> {
  const { tx } = ctx;
  // One at a time per phone number, so a double submit cannot slip two applications past the check below.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`applicant:${input.phone}`}, 0))`);
  await openApplicationFor(tx, input.phone, null);
  if (input.openingId) await openingTakingApplications(tx, input.openingId);
  const today = istDate();
  const appliedOn = input.appliedOn ?? today;
  if (appliedOn > today) throw badRequest('The application date cannot be in the future');
  const { number } = await nextNumber(tx, 'applicant', today);
  const [row] = await tx
    .insert(applicants)
    .values({
      applicantNo: number, name: input.name, phone: input.phone, email: input.email ?? null, openingId: input.openingId ?? null,
      source: input.source, sourceDetail: input.sourceDetail ?? null, resumeUrl: input.resumeUrl ?? null,
      experienceYears: input.experienceYears ?? null, currentCompany: input.currentCompany ?? null,
      expectedSalary: input.expectedSalary ?? null, ownerId: input.ownerId ?? ctx.user?.id ?? null, appliedOn,
      notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await note(ctx, row!.id, 'note', `Application received via ${[words(input.source), input.sourceDetail].filter(Boolean).join(' / ')}`);
  await audit(ctx, 'applicant', row!.id, 'create', null, { applicantNo: number, name: input.name, openingId: input.openingId ?? null });
  return row!;
}

async function lockApplicant(tx: DB, id: string): Promise<Applicant> {
  const [a] = await tx.select().from(applicants).where(eq(applicants.id, id)).for('update');
  return must(a, 'Applicant');
}

async function cancelPendingInterviews(ctx: Ctx, applicantId: string): Promise<void> {
  await ctx.tx
    .update(interviews)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(interviews.applicantId, applicantId), eq(interviews.status, 'scheduled')));
}

export async function moveApplicant(
  ctx: Ctx,
  id: string,
  input: { stage: ApplicantStage; rejectReason?: RejectReason | null; note?: string | null },
): Promise<Applicant> {
  const { tx } = ctx;
  const a = await lockApplicant(tx, id);
  const from = a.stage;
  if (input.stage === 'hired') throw badRequest('Use Hire to turn an applicant into an employee');
  if (from === input.stage) throw badRequest(`The applicant is already ${APPLICANT_STAGE_LABELS[from]}`);
  if (!canMoveApplicant(from, input.stage)) {
    throw conflict(`An applicant cannot move from ${APPLICANT_STAGE_LABELS[from]} to ${APPLICANT_STAGE_LABELS[input.stage]}`);
  }
  const patch: Partial<typeof applicants.$inferInsert> = { stage: input.stage, updatedAt: new Date() };
  if (input.stage === 'rejected') {
    if (!input.rejectReason) throw badRequest('Pick a reason for the rejection');
    patch.rejectReason = input.rejectReason;
    patch.closedAt = new Date();
    await cancelPendingInterviews(ctx, id);
  } else {
    if (from === 'rejected') await openApplicationFor(tx, a.phone, id); // reopening
    patch.rejectReason = null;
    patch.closedAt = null;
    if (!a.qualifiedAt) patch.qualifiedAt = new Date();
  }
  const [updated] = await tx.update(applicants).set(patch).where(eq(applicants.id, id)).returning();
  const why = input.stage === 'rejected' ? ` (${words(input.rejectReason!)})` : '';
  await note(ctx, id, 'stage_change',
    `${APPLICANT_STAGE_LABELS[from]} -> ${APPLICANT_STAGE_LABELS[input.stage]}${why}${input.note ? `: ${input.note}` : ''}`);
  await audit(ctx, 'applicant', id, 'stage_change', { stage: from }, { stage: input.stage, rejectReason: patch.rejectReason ?? null });
  return updated!;
}

export async function scheduleInterview(
  ctx: Ctx,
  applicantId: string,
  input: { title: string; scheduledAt: Date; mode?: (typeof INTERVIEW_MODES)[number]; interviewerId?: string | null },
): Promise<Interview> {
  const { tx } = ctx;
  const a = await lockApplicant(tx, applicantId);
  if (!['applied', 'shortlisted', 'interview'].includes(a.stage)) {
    throw conflict(`An interview cannot be booked for an applicant who is ${APPLICANT_STAGE_LABELS[a.stage]}`);
  }
  let interviewerName: string | null = null;
  if (input.interviewerId) {
    const [u] = await tx.select({ name: users.name, active: users.active }).from(users).where(eq(users.id, input.interviewerId));
    if (!u || !u.active) throw badRequest('Pick an interviewer who has an active sign-in');
    interviewerName = u.name;
  }
  const [last] = await rows<{ round: number }>(tx, sql`select coalesce(max(round), 0)::int as round from interviews where applicant_id = ${applicantId}`);
  const round = last!.round + 1;
  const [row] = await tx
    .insert(interviews)
    .values({
      applicantId, round, title: input.title, scheduledAt: input.scheduledAt, mode: input.mode ?? 'in_person',
      interviewerId: input.interviewerId ?? null, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  if (a.stage !== 'interview') {
    await tx.update(applicants)
      .set({ stage: 'interview', qualifiedAt: a.qualifiedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(applicants.id, applicantId));
    await note(ctx, applicantId, 'stage_change', `${APPLICANT_STAGE_LABELS[a.stage]} -> Interview`);
  }
  await note(ctx, applicantId, 'interview',
    `Round ${round} (${input.title}) booked for ${when(input.scheduledAt)}${interviewerName ? ` with ${interviewerName}` : ''}`);
  await audit(ctx, 'interview', row!.id, 'schedule', null, { applicantId, round, scheduledAt: input.scheduledAt, interviewerId: input.interviewerId ?? null });
  return row!;
}

async function lockInterview(tx: DB, id: string): Promise<Interview> {
  const [i] = await tx.select().from(interviews).where(eq(interviews.id, id)).for('update');
  return must(i, 'Interview');
}

/** The result of a round. HR can record it, and so can the person who took the interview. */
export async function completeInterview(
  ctx: Ctx,
  id: string,
  input: { result: (typeof INTERVIEW_RESULTS)[number]; rating?: number | null; feedback?: string | null },
): Promise<Interview> {
  const { tx } = ctx;
  const i = await lockInterview(tx, id);
  const allowed = ctx.user && (can(ctx.user.role, 'hr:write') || i.interviewerId === ctx.user.id);
  if (!allowed) throw forbidden('Only HR or the interviewer can record the result');
  if (i.status !== 'scheduled') throw conflict(`This interview is already ${words(i.status)}`);
  const [updated] = await tx
    .update(interviews)
    .set({ status: 'completed', result: input.result, rating: input.rating ?? null, feedback: input.feedback ?? null, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(interviews.id, id))
    .returning();
  await note(ctx, i.applicantId, 'interview',
    `Round ${i.round} (${i.title}): ${input.result}${input.rating ? `, rated ${input.rating}/5` : ''}${input.feedback ? `. ${input.feedback}` : ''}`);
  await audit(ctx, 'interview', id, 'complete', { status: 'scheduled' }, { status: 'completed', result: input.result, rating: input.rating ?? null });
  return updated!;
}

/**
 * Hire (PRD 7.14): creates the employee from the applicant, links the two and closes the
 * application. Only from Offered. Pressing it twice returns the employee already created.
 */
export async function hireApplicant(
  ctx: Ctx,
  id: string,
  input: {
    joinDate: string; department: string; designation: string; employmentType?: (typeof EMPLOYMENT_TYPES)[number];
    monthlySalary?: string | null; userId?: string | null;
  },
): Promise<{ applicant: Applicant; employee: Employee }> {
  const { tx } = ctx;
  const a = await lockApplicant(tx, id);
  if (a.stage === 'hired') {
    const [employee] = await tx.select().from(employees).where(eq(employees.id, a.employeeId!));
    return { applicant: a, employee: employee! };
  }
  if (!canMoveApplicant(a.stage, 'hired')) {
    throw conflict(`Make the offer first: the applicant is ${APPLICANT_STAGE_LABELS[a.stage]}, and only an Offered applicant can be hired`);
  }
  const employee = await createEmployee(ctx, {
    name: a.name, phone: a.phone, email: a.email, department: input.department, designation: input.designation,
    employmentType: input.employmentType, joinDate: input.joinDate, monthlySalary: input.monthlySalary, userId: input.userId,
  });
  await cancelPendingInterviews(ctx, id);
  const [updated] = await tx
    .update(applicants)
    .set({ stage: 'hired', employeeId: employee.id, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(applicants.id, id))
    .returning();
  await note(ctx, id, 'stage_change', `Offered -> Hired as ${input.designation} (${employee.employeeNo}), joining ${formatDate(input.joinDate)}`);
  await audit(ctx, 'applicant', id, 'hire', { stage: a.stage }, { stage: 'hired', employeeId: employee.id });
  return { applicant: updated!, employee };
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export type AttendanceEntry = {
  employeeId: string; status: AttendanceStatus; checkIn?: string | null; checkOut?: string | null; note?: string | null;
};

/** Mark (or correct) one day for any number of employees. Marking the same day again replaces what was there. */
export async function saveAttendance(ctx: Ctx, date: string, entries: AttendanceEntry[]): Promise<number> {
  const { tx } = ctx;
  if (date > istDate()) throw badRequest('Attendance cannot be marked for a day that has not come yet');
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  if (ids.length !== entries.length) throw badRequest('An employee appears twice for the same day');
  const staff = await tx.select().from(employees).where(inArray(employees.id, ids));
  const byId = new Map(staff.map((e) => [e.id, e]));
  for (const e of entries) {
    const emp = byId.get(e.employeeId);
    if (!emp) throw badRequest('Unknown employee');
    if (date < emp.joinDate) throw badRequest(`${emp.name} joined on ${formatDate(emp.joinDate)}; ${formatDate(date)} is before that`);
    if (emp.leftOn && date > emp.leftOn) throw badRequest(`${emp.name} left on ${formatDate(emp.leftOn)}; ${formatDate(date)} is after that`);
    const worked = e.status === 'present' || e.status === 'half_day';
    if (!worked && (e.checkIn || e.checkOut)) throw badRequest(`${emp.name}: in and out times only apply to a day worked`);
    if (e.checkIn && e.checkOut && e.checkOut <= e.checkIn) throw badRequest(`${emp.name}: the out time must be after the in time`);
  }
  for (let i = 0; i < entries.length; i += 500) {
    await tx
      .insert(attendance)
      .values(entries.slice(i, i + 500).map((e) => ({
        employeeId: e.employeeId, date, status: e.status, checkIn: e.checkIn ?? null, checkOut: e.checkOut ?? null,
        note: e.note ?? null, createdBy: ctx.user?.id ?? null,
      })))
      .onConflictDoUpdate({
        target: [attendance.employeeId, attendance.date],
        set: {
          status: sql`excluded.status`, checkIn: sql`excluded.check_in`, checkOut: sql`excluded.check_out`, note: sql`excluded.note`,
          updatedAt: new Date(),
        },
      });
  }
  await audit(ctx, 'attendance', date, 'mark', null, { marked: entries.length });
  return entries.length;
}

const STATUS_WORDS: Record<string, AttendanceStatus> = {
  p: 'present', present: 'present', a: 'absent', absent: 'absent',
  hd: 'half_day', halfday: 'half_day', half: 'half_day',
  l: 'leave', leave: 'leave', onleave: 'leave', pl: 'leave', cl: 'leave', sl: 'leave', el: 'leave',
  wo: 'weekly_off', weeklyoff: 'weekly_off', weekoff: 'weekly_off', off: 'weekly_off',
  h: 'holiday', holiday: 'holiday', ph: 'holiday',
};

/** "9:30", "09:30:00", "9:30 AM", "6.15 pm" -> "09:30"; blank and "-" -> null; anything else -> undefined. */
export function parseClock(raw: string): string | null | undefined {
  const s = raw.trim();
  if (s === '' || s === '-' || s === '--') return null;
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const half = m[3]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const header = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Bring attendance in from the HRMS app's export (PRD 7.14). The file needs a header row with
 * an employee column (employee number or phone), a date and a status; in and out times are optional.
 * All or nothing: if any row cannot be read, nothing is saved and every problem row is listed.
 */
export async function importAttendance(ctx: Ctx, csv: string) {
  const { tx } = ctx;
  const table = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length < 2) throw badRequest('The file has no attendance rows');
  const head = table[0]!.map(header);
  const find = (...patterns: RegExp[]) => head.findIndex((h) => patterns.some((p) => p.test(h)));
  const col = {
    employee: find(/^(emp|employee|staff)(no|code|id|number)?$/, /^code$/, /^(phone|mobile)(no|number)?$/),
    date: find(/date/),
    status: find(/^status$/, /^attendance$/, /status/),
    in: find(/^(in|intime|checkin|punchin|timein|firstin)$/),
    out: find(/^(out|outtime|checkout|punchout|timeout|lastout)$/),
  };
  const missing = (['employee', 'date', 'status'] as const).filter((k) => col[k] < 0);
  if (missing.length > 0) {
    throw badRequest(`The file needs columns for employee (number or phone), date and status. Not found: ${missing.join(', ')}`);
  }

  const staff = await tx.select({ id: employees.id, employeeNo: employees.employeeNo, phone: employees.phone, status: employees.status }).from(employees);
  const byNo = new Map(staff.map((e) => [e.employeeNo.toLowerCase(), e.id]));
  const byPhone = new Map<string, string>();
  for (const e of staff) if (e.status === 'active' || !byPhone.has(e.phone)) byPhone.set(e.phone, e.id);

  const errors: { row: number; message: string }[] = [];
  const byDate = new Map<string, AttendanceEntry[]>();
  table.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const who = (r[col.employee] ?? '').trim();
    const employeeId = byNo.get(who.toLowerCase()) ?? byPhone.get(normalisePhone(who) ?? '');
    const date = parseBankDate(r[col.date] ?? '');
    const status = STATUS_WORDS[header(r[col.status] ?? '')];
    if (!employeeId) return void errors.push({ row: rowNo, message: `No employee with number or phone "${who}"` });
    if (!date) return void errors.push({ row: rowNo, message: `"${r[col.date] ?? ''}" is not a date` });
    if (!status) return void errors.push({ row: rowNo, message: `"${r[col.status] ?? ''}" is not a status (use Present, Absent, Half day, Leave, Weekly off or Holiday)` });
    const worked = status === 'present' || status === 'half_day';
    const checkIn = worked && col.in >= 0 ? parseClock(r[col.in] ?? '') : null;
    const checkOut = worked && col.out >= 0 ? parseClock(r[col.out] ?? '') : null;
    if (checkIn === undefined || checkOut === undefined) return void errors.push({ row: rowNo, message: 'The in or out time could not be read' });
    const day = byDate.get(date) ?? [];
    if (day.some((e) => e.employeeId === employeeId)) return void errors.push({ row: rowNo, message: `${who} appears twice on ${formatDate(date)}` });
    day.push({ employeeId, status, checkIn, checkOut });
    byDate.set(date, day);
  });
  if (errors.length > 0) {
    throw badRequest(`${errors.length} row(s) in the file could not be read. Nothing was imported.`, { errors: errors.slice(0, 50) });
  }
  let saved = 0;
  const days = [...byDate.keys()].sort();
  for (const day of days) saved += await saveAttendance(ctx, day, byDate.get(day)!);
  return { rows_in_file: table.length - 1, saved, days: days.length, from: days[0]!, to: days.at(-1)! };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const zApplicant = z.object({
  name: zText(150),
  phone: zPhone,
  email: emptyToNull(z.string().email().max(200)).optional(),
  opening_id: emptyToNull(zId).optional(),
  source: z.enum(APPLICANT_SOURCES),
  source_detail: emptyToNull(z.string().trim().max(200)).optional(),
  resume_url: emptyToNull(zLink).optional(),
  experience_years: emptyToNull(zYears).optional(),
  current_company: emptyToNull(z.string().trim().max(200)).optional(),
  expected_salary: emptyToNull(zMoney).optional(),
  owner_id: emptyToNull(zId).optional(),
  applied_on: emptyToNull(zDate).optional(),
  notes: emptyToNull(z.string().trim().max(2000)).optional(),
});

const zEmployee = z.object({
  name: zText(150),
  phone: zPhone,
  email: emptyToNull(z.string().email().max(200)).optional(),
  department: zText(100),
  designation: zText(100),
  employment_type: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  join_date: zDate,
  monthly_salary: emptyToNull(zMoney).optional(),
  user_id: emptyToNull(zId).optional(),
  notes: emptyToNull(z.string().trim().max(2000)).optional(),
  annual_leave_days: emptyToNull(zLeaveDays).optional(),
});

const INTERVIEW_SELECT = sql`
  select i.id, i.round, i.title, i.scheduled_at, i.mode, i.status, i.result, i.rating, i.feedback, i.completed_at,
         i.interviewer_id, u.name as interviewer_name, a.id as applicant_id, a.applicant_no, a.name as applicant_name,
         a.stage as applicant_stage, a.resume_url, a.experience_years, a.current_company, o.title as opening_title
    from interviews i
    join applicants a on a.id = i.applicant_id
    left join job_openings o on o.id = a.opening_id
    left join users u on u.id = i.interviewer_id`;

export function hrRouter(db: DB) {
  const r = Router();

  // ---- openings ------------------------------------------------------------
  r.get('/openings', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ status: z.enum(OPENING_STATUSES).optional() }).parse(req.query);
    const data = await rows(db, sql`
      select o.*,
             (select count(*)::int from applicants a where a.opening_id = o.id) as applicants,
             (select count(*)::int from applicants a where a.opening_id = o.id and a.stage in ('applied','shortlisted','interview','offered')) as in_progress,
             (select count(*)::int from applicants a where a.opening_id = o.id and a.stage = 'hired') as hired
        from job_openings o
       where (${q.status ?? null}::text is null or o.status::text = ${q.status ?? null})
       order by (o.status = 'open') desc, o.opened_on desc, o.created_at desc`);
    sendList(req, res, data, 'openings');
  });

  r.post('/openings', requirePerm('hr:write'), async (req, res) => {
    const b = z.object({
      title: zText(150), department: zText(100), positions: z.coerce.number().int().min(1).max(500).default(1),
      description: emptyToNull(z.string().trim().max(4000)).optional(), opened_on: emptyToNull(zDate).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [o] = await ctx.tx.insert(jobOpenings).values({
        title: b.title, department: b.department, positions: b.positions, description: b.description ?? null,
        openedOn: b.opened_on ?? istDate(), createdBy: ctx.user?.id ?? null,
      }).returning();
      await audit(ctx, 'job_opening', o!.id, 'create', null, { title: b.title, department: b.department, positions: b.positions });
      return o!;
    });
    res.status(201).json({ data: row });
  });

  /**
   * Edit an opening or change its status. Closing one that still has applicants in progress is
   * refused unless reject_open is set, which rejects them all as "position filled" in the same step.
   */
  r.patch('/openings/:id', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      title: zText(150).optional(), department: zText(100).optional(), positions: z.coerce.number().int().min(1).max(500).optional(),
      description: emptyToNull(z.string().trim().max(4000)).optional(), status: z.enum(OPENING_STATUSES).optional(),
      reject_open: z.boolean().optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [o] = await ctx.tx.select().from(jobOpenings).where(eq(jobOpenings.id, id)).for('update');
      must(o, 'Opening');
      const patch: Partial<typeof jobOpenings.$inferInsert> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.department !== undefined) patch.department = b.department;
      if (b.positions !== undefined) patch.positions = b.positions;
      if (b.description !== undefined) patch.description = b.description;
      if (b.status !== undefined && b.status !== o!.status) {
        patch.status = b.status;
        patch.closedOn = b.status === 'closed' ? istDate() : null;
        if (b.status === 'closed') {
          const open = await ctx.tx.select({ id: applicants.id }).from(applicants)
            .where(and(eq(applicants.openingId, id), inArray(applicants.stage, OPEN_APPLICANT_STAGES)));
          if (open.length > 0 && !b.reject_open) {
            throw conflict(`${open.length} applicant(s) are still in progress for this opening. Decide on them first, or close and reject them together.`,
              { inProgress: open.length });
          }
          for (const a of open) await moveApplicant(ctx, a.id, { stage: 'rejected', rejectReason: 'position_filled', note: 'Opening closed' });
        }
      }
      const [updated] = await ctx.tx.update(jobOpenings).set(patch).where(eq(jobOpenings.id, id)).returning();
      await audit(ctx, 'job_opening', id, 'update', { status: o!.status, positions: o!.positions }, { status: updated!.status, positions: updated!.positions });
      return updated!;
    });
    res.json({ data: row });
  });

  // ---- applicants ----------------------------------------------------------
  r.get('/applicants', requirePerm('hr:read'), async (req, res) => {
    const q = zListQuery.extend({
      stage: z.enum(APPLICANT_STAGES).optional(), opening_id: zId.optional(), source: z.enum(APPLICANT_SOURCES).optional(),
      view: z.enum(['open']).optional(), from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const digits = q.q ? q.q.replace(/\D/g, '') : '';
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    const data = await rows(db, sql`
      select a.*, o.title as opening_title, u.name as owner_name,
             (select count(*)::int from interviews i where i.applicant_id = a.id) as interviews,
             (select min(i.scheduled_at) from interviews i where i.applicant_id = a.id and i.status = 'scheduled') as next_interview_at
        from applicants a
        left join job_openings o on o.id = a.opening_id
        left join users u on u.id = a.owner_id
       where (${q.stage ?? null}::text is null or a.stage::text = ${q.stage ?? null})
         and (${q.opening_id ?? null}::uuid is null or a.opening_id = ${q.opening_id ?? null}::uuid)
         and (${q.source ?? null}::text is null or a.source::text = ${q.source ?? null})
         and (${q.view ?? null}::text is null or a.stage in ('applied','shortlisted','interview','offered'))
         and (${q.from ?? null}::date is null or a.applied_on >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or a.applied_on <= ${q.to ?? null}::date)
         and (${like}::text is null or a.name ilike ${like} or a.applicant_no ilike ${like}
              or (${phoneLike}::text is not null and a.phone like ${phoneLike}))
       order by a.applied_on desc, a.created_at desc, a.applicant_no desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'applicants');
  });

  /** The hiring board: everyone still in progress, by stage. */
  r.get('/applicants/pipeline', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ opening_id: zId.optional() }).parse(req.query);
    const data = await rows(db, sql`
      select a.id, a.applicant_no, a.name, a.phone, a.stage, a.applied_on, a.experience_years, o.title as opening_title,
             (select min(i.scheduled_at) from interviews i where i.applicant_id = a.id and i.status = 'scheduled') as next_interview_at,
             ((now() at time zone 'Asia/Kolkata')::date - a.applied_on)::int as days_open
        from applicants a left join job_openings o on o.id = a.opening_id
       where a.stage in ('applied','shortlisted','interview','offered')
         and (${q.opening_id ?? null}::uuid is null or a.opening_id = ${q.opening_id ?? null}::uuid)
       order by a.applied_on, a.created_at`);
    res.json({ data, stages: OPEN_APPLICANT_STAGES });
  });

  r.get('/applicants/:id', requirePerm('hr:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [a] = await rows<{ phone: string }>(db, sql`
      select a.*, o.title as opening_title, o.department as opening_department, u.name as owner_name,
             e.employee_no, e.name as employee_name
        from applicants a
        left join job_openings o on o.id = a.opening_id
        left join users u on u.id = a.owner_id
        left join employees e on e.id = a.employee_id
       where a.id = ${id}`);
    must(a, 'Applicant');
    const activities = await rows(db, sql`
      select x.id, x.type, x.note, x.at, u.name as user_name
        from applicant_activities x left join users u on u.id = x.user_id
       where x.applicant_id = ${id} order by x.at desc, x.id`);
    const rounds = await rows(db, sql`${INTERVIEW_SELECT} where i.applicant_id = ${id} order by i.round`);
    const earlier = await rows(db, sql`
      select p.id, p.applicant_no, p.stage, p.applied_on, p.reject_reason, o.title as opening_title
        from applicants p left join job_openings o on o.id = p.opening_id
       where p.phone = ${a!.phone} and p.id <> ${id} order by p.applied_on desc`);
    res.json({ data: { ...a, activities, interviews: rounds, earlier_applications: earlier } });
  });

  r.post('/applicants', requirePerm('hr:write'), async (req, res) => {
    const b = zApplicant.parse(req.body);
    const row = await inTx(db, req, (ctx) =>
      createApplicant(ctx, {
        name: b.name, phone: b.phone, email: b.email, openingId: b.opening_id, source: b.source, sourceDetail: b.source_detail,
        resumeUrl: b.resume_url, experienceYears: b.experience_years, currentCompany: b.current_company,
        expectedSalary: b.expected_salary, ownerId: b.owner_id, appliedOn: b.applied_on, notes: b.notes,
      }));
    res.status(201).json({ data: row });
  });

  r.patch('/applicants/:id', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zApplicant.partial().parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const a = await lockApplicant(ctx.tx, id);
      const open = OPEN_APPLICANT_STAGES.includes(a.stage);
      const patch: Partial<typeof applicants.$inferInsert> = { updatedAt: new Date() };
      if (b.phone !== undefined && b.phone !== a.phone) {
        if (a.stage === 'hired') throw conflict('This applicant is now an employee; change the phone number on the employee record');
        if (open) await openApplicationFor(ctx.tx, b.phone, id);
        patch.phone = b.phone;
      }
      if (b.opening_id !== undefined && b.opening_id !== a.openingId) {
        if (!open) throw conflict('The opening can only be changed while the application is in progress');
        if (b.opening_id) await openingTakingApplications(ctx.tx, b.opening_id);
        patch.openingId = b.opening_id;
      }
      if (b.name !== undefined) patch.name = b.name;
      if (b.email !== undefined) patch.email = b.email;
      if (b.source !== undefined) patch.source = b.source;
      if (b.source_detail !== undefined) patch.sourceDetail = b.source_detail;
      if (b.resume_url !== undefined) patch.resumeUrl = b.resume_url;
      if (b.experience_years !== undefined) patch.experienceYears = b.experience_years;
      if (b.current_company !== undefined) patch.currentCompany = b.current_company;
      if (b.expected_salary !== undefined) patch.expectedSalary = b.expected_salary;
      if (b.owner_id !== undefined) patch.ownerId = b.owner_id;
      if (b.notes !== undefined) patch.notes = b.notes;
      const [updated] = await ctx.tx.update(applicants).set(patch).where(eq(applicants.id, id)).returning();
      await audit(ctx, 'applicant', id, 'update', { name: a.name, phone: a.phone, openingId: a.openingId }, { name: updated!.name, phone: updated!.phone, openingId: updated!.openingId });
      return updated!;
    });
    res.json({ data: row });
  });

  r.post('/applicants/:id/stage', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      stage: z.enum(APPLICANT_STAGES), reject_reason: emptyToNull(z.enum(REJECT_REASONS)).optional(),
      note: emptyToNull(z.string().trim().max(1000)).optional(),
    }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => moveApplicant(ctx, id, { stage: b.stage, rejectReason: b.reject_reason, note: b.note })) });
  });

  r.post('/applicants/:id/activities', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ type: z.enum(['note', 'call']), note: zText(2000) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      await lockApplicant(ctx.tx, id);
      await note(ctx, id, b.type, b.note);
    });
    res.status(201).json({ ok: true });
  });

  r.post('/applicants/:id/interviews', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      title: zText(100), scheduled_at: zWhen, mode: z.enum(INTERVIEW_MODES).default('in_person'), interviewer_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, (ctx) =>
      scheduleInterview(ctx, id, { title: b.title, scheduledAt: b.scheduled_at, mode: b.mode, interviewerId: b.interviewer_id }));
    res.status(201).json({ data: row });
  });

  r.post('/applicants/:id/hire', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      join_date: zDate, department: zText(100), designation: zText(100), employment_type: z.enum(EMPLOYMENT_TYPES).default('full_time'),
      monthly_salary: emptyToNull(zMoney).optional(), user_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const result = await inTx(db, req, (ctx) =>
      hireApplicant(ctx, id, {
        joinDate: b.join_date, department: b.department, designation: b.designation, employmentType: b.employment_type,
        monthlySalary: b.monthly_salary, userId: b.user_id,
      }));
    res.status(201).json({ data: result });
  });

  // ---- interviews ----------------------------------------------------------
  /** For whoever is taking interviews, whatever their role: the rounds assigned to them that still need a result. */
  r.get('/interviews/mine', requireAuth, async (req, res) => {
    const data = await rows(db, sql`${INTERVIEW_SELECT}
       where i.interviewer_id = ${req.user!.id} and i.status = 'scheduled' order by i.scheduled_at`);
    res.json({ data });
  });

  r.get('/interviews', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({
      status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(), from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const data = await rows(db, sql`${INTERVIEW_SELECT}
       where (${q.status ?? null}::text is null or i.status::text = ${q.status ?? null})
         and (${q.from ?? null}::date is null or (i.scheduled_at at time zone 'Asia/Kolkata')::date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or (i.scheduled_at at time zone 'Asia/Kolkata')::date <= ${q.to ?? null}::date)
       order by i.scheduled_at desc limit 1000`);
    sendList(req, res, data, 'interviews');
  });

  r.post('/interviews/:id/complete', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      result: z.enum(INTERVIEW_RESULTS), rating: emptyToNull(z.coerce.number().int().min(1).max(5)).optional(),
      feedback: emptyToNull(z.string().trim().max(4000)).optional(),
    }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => completeInterview(ctx, id, b)) });
  });

  /** Move a booked round to another time or interviewer. */
  r.patch('/interviews/:id', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      title: zText(100).optional(), scheduled_at: zWhen.optional(), mode: z.enum(INTERVIEW_MODES).optional(),
      interviewer_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const i = await lockInterview(ctx.tx, id);
      if (i.status !== 'scheduled') throw conflict(`This interview is already ${words(i.status)}`);
      if (b.interviewer_id) {
        const [u] = await ctx.tx.select({ active: users.active }).from(users).where(eq(users.id, b.interviewer_id));
        if (!u || !u.active) throw badRequest('Pick an interviewer who has an active sign-in');
      }
      const patch: Partial<typeof interviews.$inferInsert> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.scheduled_at !== undefined) patch.scheduledAt = b.scheduled_at;
      if (b.mode !== undefined) patch.mode = b.mode;
      if (b.interviewer_id !== undefined) patch.interviewerId = b.interviewer_id;
      const [updated] = await ctx.tx.update(interviews).set(patch).where(eq(interviews.id, id)).returning();
      if (b.scheduled_at && b.scheduled_at.getTime() !== i.scheduledAt.getTime()) {
        await note(ctx, i.applicantId, 'interview', `Round ${i.round} (${updated!.title}) moved to ${when(b.scheduled_at)}`);
      }
      await audit(ctx, 'interview', id, 'reschedule', { scheduledAt: i.scheduledAt, interviewerId: i.interviewerId }, { scheduledAt: updated!.scheduledAt, interviewerId: updated!.interviewerId });
      return updated!;
    });
    res.json({ data: row });
  });

  /** The round did not happen: called off, or the applicant did not turn up. */
  r.post('/interviews/:id/cancel', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ status: z.enum(['cancelled', 'no_show']).default('cancelled'), note: emptyToNull(z.string().trim().max(1000)).optional() }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const i = await lockInterview(ctx.tx, id);
      if (i.status !== 'scheduled') throw conflict(`This interview is already ${words(i.status)}`);
      await ctx.tx.update(interviews).set({ status: b.status, feedback: b.note ?? i.feedback, updatedAt: new Date() }).where(eq(interviews.id, id));
      await note(ctx, i.applicantId, 'interview',
        `Round ${i.round} (${i.title}) ${b.status === 'no_show' ? 'did not happen: the applicant did not turn up' : 'cancelled'}${b.note ? `. ${b.note}` : ''}`);
      await audit(ctx, 'interview', id, 'cancel', { status: 'scheduled' }, { status: b.status });
    });
    res.json({ ok: true });
  });

  // ---- employees -----------------------------------------------------------
  r.get('/employees', requirePerm('hr:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(['active', 'left']).optional(), department: z.string().trim().max(100).optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select e.*, u.name as user_name, u.role as user_role
        from employees e left join users u on u.id = e.user_id
       where (${q.status ?? null}::text is null or e.status::text = ${q.status ?? null})
         and (${q.department ?? null}::text is null or e.department = ${q.department ?? null})
         and (${like}::text is null or e.name ilike ${like} or e.employee_no ilike ${like} or e.phone like ${like})
       order by (e.status = 'active') desc, e.name
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'employees');
  });

  r.get('/employees/:id', requirePerm('hr:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [e] = await rows(db, sql`
      select e.*, u.name as user_name, u.role as user_role, u.active as user_active,
             a.id as applicant_id, a.applicant_no
        from employees e
        left join users u on u.id = e.user_id
        left join applicants a on a.employee_id = e.id
       where e.id = ${id}`);
    must(e, 'Employee');
    const recent = await rows(db, sql`
      select a.date, a.status, to_char(a.check_in, 'HH24:MI') as check_in, to_char(a.check_out, 'HH24:MI') as check_out, a.note
        from attendance a where a.employee_id = ${id} order by a.date desc limit 31`);
    res.json({ data: { ...e, recent_attendance: recent } });
  });

  /** Add someone already working here; new joiners normally arrive through Hire on their application. */
  r.post('/employees', requirePerm('hr:write'), async (req, res) => {
    const b = zEmployee.parse(req.body);
    const row = await inTx(db, req, (ctx) =>
      createEmployee(ctx, {
        name: b.name, phone: b.phone, email: b.email, department: b.department, designation: b.designation,
        employmentType: b.employment_type, joinDate: b.join_date, monthlySalary: b.monthly_salary, userId: b.user_id, notes: b.notes,
        annualLeaveDays: b.annual_leave_days,
      }));
    res.status(201).json({ data: row });
  });

  r.patch('/employees/:id', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zEmployee.partial().parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(employees).where(eq(employees.id, id)).for('update');
      must(e, 'Employee');
      const patch: Partial<typeof employees.$inferInsert> = { updatedAt: new Date() };
      if (b.phone !== undefined && b.phone !== e!.phone) {
        if (e!.status === 'active') await checkNotOnRolls(ctx.tx, b.phone, id);
        patch.phone = b.phone;
      }
      if (b.user_id !== undefined && b.user_id !== e!.userId) {
        if (b.user_id) await checkSignIn(ctx.tx, b.user_id, id);
        patch.userId = b.user_id;
      }
      if (b.join_date !== undefined && b.join_date !== e!.joinDate) {
        const [early] = await rows<{ n: number }>(ctx.tx, sql`select count(*)::int as n from attendance where employee_id = ${id} and date < ${b.join_date}::date`);
        if (early!.n > 0) throw conflict(`Attendance is already marked for ${early!.n} day(s) before that joining date`);
        if (e!.leftOn && b.join_date > e!.leftOn) throw badRequest('The joining date cannot be after the leaving date');
        patch.joinDate = b.join_date;
      }
      if (b.name !== undefined) patch.name = b.name;
      if (b.email !== undefined) patch.email = b.email;
      if (b.department !== undefined) patch.department = b.department;
      if (b.designation !== undefined) patch.designation = b.designation;
      if (b.employment_type !== undefined && req.body.employment_type !== undefined) patch.employmentType = b.employment_type;
      if (b.monthly_salary !== undefined) patch.monthlySalary = b.monthly_salary;
      if (b.annual_leave_days !== undefined) patch.annualLeaveDays = b.annual_leave_days;
      if (b.notes !== undefined) patch.notes = b.notes;
      const [updated] = await ctx.tx.update(employees).set(patch).where(eq(employees.id, id)).returning();
      await audit(ctx, 'employee', id, 'update',
        { department: e!.department, designation: e!.designation, monthlySalary: e!.monthlySalary, userId: e!.userId },
        { department: updated!.department, designation: updated!.designation, monthlySalary: updated!.monthlySalary, userId: updated!.userId });
      return updated!;
    });
    res.json({ data: row });
  });

  /** The employee has left. Their record and attendance stay; they drop off the daily register after this date. */
  r.post('/employees/:id/exit', requirePerm('hr:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ left_on: zDate, reason: emptyToNull(z.string().trim().max(500)).optional() }).parse(req.body);
    const result = await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(employees).where(eq(employees.id, id)).for('update');
      must(e, 'Employee');
      if (e!.status === 'left') throw conflict(`${e!.name} has already left (${formatDate(e!.leftOn)})`);
      if (b.left_on > istDate()) throw badRequest('Record the exit on or after the last working day, not before it');
      if (b.left_on < e!.joinDate) throw badRequest('The last working day cannot be before the joining date');
      const [late] = await rows<{ n: number }>(ctx.tx, sql`select count(*)::int as n from attendance where employee_id = ${id} and date > ${b.left_on}::date`);
      if (late!.n > 0) throw conflict(`Attendance is marked for ${late!.n} day(s) after that date. Correct it first.`);
      const [updated] = await ctx.tx.update(employees)
        .set({ status: 'left', leftOn: b.left_on, leftReason: b.reason ?? null, updatedAt: new Date() })
        .where(eq(employees.id, id)).returning();
      await audit(ctx, 'employee', id, 'exit', { status: 'active' }, { status: 'left', leftOn: b.left_on });
      const [signIn] = e!.userId
        ? await ctx.tx.select({ active: users.active }).from(users).where(eq(users.id, e!.userId))
        : [];
      return { employee: updated!, sign_in_still_active: Boolean(signIn?.active) };
    });
    res.json({ data: result.employee, sign_in_still_active: result.sign_in_still_active });
  });

  // ---- attendance ----------------------------------------------------------
  /** The register for one day: everyone on the rolls that day, with what has been marked so far. */
  r.get('/attendance', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ date: zDate.optional() }).parse(req.query);
    const day = q.date ?? istDate();
    const data = await rows(db, sql`
      select e.id as employee_id, e.employee_no, e.name, e.department, e.designation,
             a.status, to_char(a.check_in, 'HH24:MI') as check_in, to_char(a.check_out, 'HH24:MI') as check_out, a.note
        from employees e
        left join attendance a on a.employee_id = e.id and a.date = ${day}::date
       where e.join_date <= ${day}::date and (e.left_on is null or e.left_on >= ${day}::date)
       order by e.department, e.name`);
    if (wantsFile(req)) return sendList(req, res, data, `attendance-${day}`);
    res.json({ data, date: day });
  });

  r.put('/attendance', requirePerm('hr:write'), async (req, res) => {
    const b = z.object({
      date: zDate,
      entries: z.array(z.object({
        employee_id: zId, status: z.enum(ATTENDANCE_STATUSES), check_in: emptyToNull(zClock).optional(),
        check_out: emptyToNull(zClock).optional(), note: emptyToNull(z.string().trim().max(300)).optional(),
      })).min(1).max(2000),
    }).parse(req.body);
    const marked = await inTx(db, req, (ctx) =>
      saveAttendance(ctx, b.date, b.entries.map((e) => ({ employeeId: e.employee_id, status: e.status, checkIn: e.check_in, checkOut: e.check_out, note: e.note }))));
    res.json({ data: { date: b.date, marked } });
  });

  r.post('/attendance/import', requirePerm('hr:write'), async (req, res) => {
    const b = z.object({ csv: z.string().min(1, 'the file is empty') }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => importAttendance(ctx, b.csv)) });
  });

  /** One line per employee for a month: days in each status, days worked, and days nobody has marked yet. */
  r.get('/attendance/summary', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month (YYYY-MM)').optional() }).parse(req.query);
    const today = istDate();
    const month = q.month ?? today.slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-${String(lastDayOfMonth(from)).padStart(2, '0')}`;
    const data = await rows(db, sql`
      with span as (select ${from}::date as d1, least(${to}::date, ${today}::date) as d2)
      select e.id as employee_id, e.employee_no, e.name, e.department,
             count(a.id) filter (where a.status = 'present')::int as present,
             count(a.id) filter (where a.status = 'half_day')::int as half_day,
             count(a.id) filter (where a.status = 'absent')::int as absent,
             count(a.id) filter (where a.status = 'leave')::int as leave,
             count(a.id) filter (where a.status = 'weekly_off')::int as weekly_off,
             count(a.id) filter (where a.status = 'holiday')::int as holiday,
             (count(a.id) filter (where a.status = 'present') + 0.5 * count(a.id) filter (where a.status = 'half_day'))::numeric(6,1) as days_worked,
             greatest(0, (least(span.d2, coalesce(e.left_on, span.d2)) - greatest(span.d1, e.join_date) + 1) - count(a.id))::int as not_marked
        from employees e
        cross join span
        left join attendance a on a.employee_id = e.id and a.date between span.d1 and span.d2
       where e.join_date <= span.d2 and (e.left_on is null or e.left_on >= span.d1)
       group by e.id, span.d1, span.d2
       order by e.department, e.name`);
    if (wantsFile(req)) return sendList(req, res, data, `attendance-${month}`);
    res.json({ data, month, from, to });
  });

  // ---- leave --------------------------------------------------------------
  /**
   * Leave for a leave year (the financial year): what each person is entitled to, what they
   * have taken (days marked as Leave in the register) and what is left. A negative balance is
   * leave taken beyond the entitlement.
   */
  r.get('/leave-balances', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const fy = q.fy ?? fyOf(istDate());
    const year = fyRange(fy);
    const policy = await getSetting(db, 'annual_leave_days');
    const staff = await rows<{ employee_id: string; join_date: string; annual_leave_days: string | null; taken: number }>(db, sql`
      select e.id as employee_id, e.employee_no, e.name, e.department, e.join_date, e.status, e.annual_leave_days,
             (select count(*)::int from attendance a where a.employee_id = e.id and a.status = 'leave'
                 and a.date between ${year.from}::date and ${year.to}::date) as taken
        from employees e
       where e.join_date <= ${year.to}::date and (e.left_on is null or e.left_on >= ${year.from}::date)
       order by e.department, e.name`);
    const data = staff.map((e) => {
      const entitled = leaveEntitlement(e.annual_leave_days === null ? policy : Number(e.annual_leave_days), e.join_date, year);
      return { ...e, own_rule: e.annual_leave_days !== null, entitled, balance: entitled - e.taken };
    });
    if (wantsFile(req)) return sendList(req, res, data, `leave-${fy}`);
    res.json({ data, fy, from: year.from, to: year.to, annual_leave_days: policy });
  });

  /** The number of leave days a year for everyone who has no figure of their own. */
  r.put('/leave-policy', requirePerm('hr:write'), async (req, res) => {
    const b = z.object({ annual_leave_days: z.coerce.number().min(0).max(365) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'annual_leave_days');
      await setSetting(ctx.tx, 'annual_leave_days', b.annual_leave_days, ctx.user!.id);
      await audit(ctx, 'settings', 'annual_leave_days', 'update', { value: before }, { value: b.annual_leave_days });
    });
    res.json({ data: { annual_leave_days: b.annual_leave_days } });
  });

  // ---- dashboard -----------------------------------------------------------
  /**
   * What the founder asked to see (call of 7 Oct 2026): how many resumes are coming in, how many
   * qualify, how many are rejected and what stage everyone is in; plus interviews, headcount and today's attendance.
   */
  r.get('/dashboard', requirePerm('hr:read'), async (req, res) => {
    const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const today = istDate();
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? today;
    const inRange = sql`a.applied_on between ${from}::date and ${to}::date`;

    const [totals] = await rows(db, sql`
      select count(*)::int as received,
             count(*) filter (where a.qualified_at is not null)::int as qualified,
             count(*) filter (where a.stage = 'rejected')::int as rejected,
             count(*) filter (where a.stage = 'rejected' and a.qualified_at is null)::int as rejected_at_screening,
             count(*) filter (where a.stage = 'hired')::int as hired,
             count(*) filter (where a.stage in ('applied','shortlisted','interview','offered'))::int as in_progress
        from applicants a where ${inRange}`);
    const byStage = await rows(db, sql`
      select a.stage, count(*)::int as count from applicants a where ${inRange} group by a.stage`);
    const pipeline = await rows(db, sql`
      select a.stage, count(*)::int as count from applicants a
       where a.stage in ('applied','shortlisted','interview','offered') group by a.stage`);
    const bySource = await rows(db, sql`
      select a.source, count(*)::int as applicants, count(*) filter (where a.stage = 'hired')::int as hired
        from applicants a where ${inRange} group by a.source order by applicants desc, a.source`);
    const byDay = await rows(db, sql`
      select a.applied_on as day, count(*)::int as applicants from applicants a where ${inRange} group by a.applied_on order by a.applied_on`);
    const rejections = await rows(db, sql`
      select a.reject_reason as reason, count(*)::int as count from applicants a
       where a.stage = 'rejected' and (a.closed_at at time zone 'Asia/Kolkata')::date between ${from}::date and ${to}::date
       group by a.reject_reason order by count desc`);
    const [hiring] = await rows(db, sql`
      select count(*)::int as hired,
             percentile_cont(0.5) within group (order by ((a.closed_at at time zone 'Asia/Kolkata')::date - a.applied_on))::numeric(6,1) as median_days_to_hire
        from applicants a
       where a.stage = 'hired' and (a.closed_at at time zone 'Asia/Kolkata')::date between ${from}::date and ${to}::date`);
    const openings = await rows(db, sql`
      select o.id, o.title, o.department, o.positions, o.opened_on,
             (select count(*)::int from applicants a where a.opening_id = o.id) as applicants,
             (select count(*)::int from applicants a where a.opening_id = o.id and a.stage in ('applied','shortlisted','interview','offered')) as in_progress,
             (select count(*)::int from applicants a where a.opening_id = o.id and a.stage = 'hired') as hired
        from job_openings o where o.status = 'open' order by o.opened_on`);
    const upcoming = await rows(db, sql`${INTERVIEW_SELECT}
       where i.status = 'scheduled' and i.scheduled_at >= now() and i.scheduled_at < now() + interval '7 days'
       order by i.scheduled_at limit 30`);
    const [awaiting] = await rows(db, sql`
      select count(*)::int as count from interviews i where i.status = 'scheduled' and i.scheduled_at < now()`);
    const headcount = await rows(db, sql`
      select e.department, count(*)::int as count from employees e where e.status = 'active' group by e.department order by count desc, e.department`);
    const [attendanceToday] = await rows(db, sql`
      select count(*)::int as on_rolls,
             count(a.id) filter (where a.status = 'present')::int as present,
             count(a.id) filter (where a.status = 'half_day')::int as half_day,
             count(a.id) filter (where a.status = 'absent')::int as absent,
             count(a.id) filter (where a.status = 'leave')::int as leave,
             count(a.id) filter (where a.status in ('weekly_off','holiday'))::int as off,
             count(*) filter (where a.id is null)::int as not_marked
        from employees e left join attendance a on a.employee_id = e.id and a.date = ${today}::date
       where e.join_date <= ${today}::date and (e.left_on is null or e.left_on >= ${today}::date)`);
    res.json({
      data: {
        range: { from, to }, totals, by_stage: byStage, pipeline, by_source: bySource, applicants_by_day: byDay, rejections,
        hiring, openings, interviews_upcoming: upcoming, interviews_awaiting_result: awaiting, headcount, attendance_today: attendanceToday,
      },
    });
  });

  return r;
}
