import crypto from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  D, addDays, amountInWords, computePay, fyOf, fyRange, istDate, lastDayOfMonth, leaveEntitlement, money, monthName, weekdayOf, type PayrollRules,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requireAuth, requirePerm } from '../core/auth';
import { assertMoneyAccount, postJournal, reverseJournals } from '../core/journal';
import { getCompany, getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { advanceRecoveries, employees, payrollRuns, payslips, salaryAdvances } from '../db/schema';
import { AppError, badRequest, conflict, forbidden, must } from '../lib/errors';
import { recordSalary } from './hr';
import { emptyToNull, inTx, sendList, zDate, zId, zMoney, zMoneyPos, zMonth, wantsFile, type Ctx } from '../lib/http';

/**
 * Payroll: the month's salary worked out from the attendance register.
 *
 *   draft     payslips are calculated and can be recalculated as the register is corrected
 *   approved  the salary is in the books (expense, what is owed to staff and to PF / ESIC / tax), advances are recovered
 *   paid      the net salaries have gone out of the bank
 *
 * Paid days are days worked, paid leave, weekly offs and holidays; a half day counts as half.
 * Absent days and working days nobody marked are not paid. A weekly off needs no marking.
 */

type Run = typeof payrollRuns.$inferSelect;
type Slip = typeof payslips.$inferSelect;
const monthSpan = (month: string) => {
  const from = `${month}-01`;
  return { from, to: `${month}-${String(lastDayOfMonth(from)).padStart(2, '0')}`, days: lastDayOfMonth(from) };
};

// ---------------------------------------------------------------------------
// Working out the month
// ---------------------------------------------------------------------------
/** What is due this month against each person's advances: the monthly amount, or what is left if that is less. */
async function advancesDue(tx: DB, upTo: string) {
  return rows<{ id: string; employee_id: string; due: string; outstanding: string }>(tx, sql`
    select a.id, a.employee_id,
           (a.amount - coalesce(r.recovered, 0))::numeric(12,2)::text as outstanding,
           least(a.monthly_recovery, a.amount - coalesce(r.recovered, 0))::numeric(12,2)::text as due
      from salary_advances a
      left join (select advance_id, sum(amount) as recovered from advance_recoveries group by advance_id) r on r.advance_id = a.id
     where a.cancelled_at is null and a.given_on <= ${upTo}::date and a.amount - coalesce(r.recovered, 0) > 0
     order by a.given_on, a.created_at`);
}

type Revision = { employee_id: string; effective_from: string; monthly_salary: string };

/**
 * The monthly salary a month is paid at: each day at the salary in force that day (salary_revisions), averaged over
 * the month, so a raise from the 16th counts for the second half only and a past month keeps the salary it had.
 * Days before the first salary was recorded take that first salary (the person was not on the rolls then anyway).
 */
function salaryForMonth(own: Revision[], from: string, to: string, days: number): string {
  let total = D(0);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const inForce = [...own].reverse().find((r) => r.effective_from <= d) ?? own[0]!;
    total = total.plus(inForce.monthly_salary);
  }
  return money(total.div(days).toDecimalPlaces(2));
}

/** Nobody approves, changes or pays a month with their own salary in it (technical review, 26 Oct 2026). */
async function assertNotOwnPay(ctx: Ctx, runId: string, what: string): Promise<void> {
  const [mine] = await rows<{ employee_name: string }>(ctx.tx, sql`
    select s.employee_name from payslips s join employees e on e.id = s.employee_id where s.run_id = ${runId} and e.user_id = ${ctx.user?.id ?? null} limit 1`);
  if (mine) throw forbidden(`Your own salary is in this month, so someone else must ${what} it`);
}

/** Work out (or work out again) every payslip of a draft run from the register as it stands now. */
export async function calculateRun(ctx: Ctx, run: Run): Promise<void> {
  const { tx } = ctx;
  if (run.status !== 'draft') throw conflict(`The salary for ${monthName(run.month)} is already ${run.status}. Reopen it to change it.`);
  const { from, to, days } = monthSpan(run.month);
  const rules = await getSetting(tx, 'payroll_rules');
  const { weekly_off: weeklyOff } = await getSetting(tx, 'attendance_rules');
  // Everyone on the rolls in the month with a salary recorded by its last day.
  const staff = await tx.select().from(employees)
    .where(sql`${employees.joinDate} <= ${to}::date and (${employees.leftOn} is null or ${employees.leftOn} >= ${from}::date)
      and exists (select 1 from salary_revisions r where r.employee_id = ${employees.id} and r.effective_from <= ${to}::date)`)
    .orderBy(asc(employees.department), asc(employees.name));
  const revisions = await rows<Revision>(tx, sql`
    select employee_id, effective_from::text, monthly_salary::text from salary_revisions where effective_from <= ${to}::date order by employee_id, effective_from`);
  // Leave is paid up to the person's allowance for the leave year (the financial year); beyond it, it is not.
  const leaveYear = fyRange(fyOf(from));
  const leavePolicy = await getSetting(tx, 'annual_leave_days');
  const leaveBefore = new Map((await rows<{ employee_id: string; n: number }>(tx, sql`
    select employee_id, count(*)::int as n from attendance
     where status = 'leave' and date >= ${leaveYear.from}::date and date < ${from}::date group by employee_id`)).map((r) => [r.employee_id, r.n]));
  const marked = await rows<{ employee_id: string; date: string; status: string }>(tx, sql`
    select employee_id, date::text as date, status::text as status from attendance where date between ${from}::date and ${to}::date`);
  const byDay = new Map(marked.map((m) => [`${m.employee_id}:${m.date}`, m.status]));
  const due = await advancesDue(tx, to);
  const kept = new Map((await tx.select().from(payslips).where(eq(payslips.runId, run.id))).map((s) => [s.employeeId, s]));

  const seen: string[] = [];
  for (const e of staff) {
    const c = { present: 0, half_day: 0, leave: 0, weekly_off: 0, holiday: 0, absent: 0, autoOff: 0, notMarked: 0 };
    // Only the days the person was on the rolls count; before joining and after leaving there is nothing to pay.
    const first = e.joinDate > from ? e.joinDate : from;
    const last = e.leftOn && e.leftOn < to ? e.leftOn : to;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const status = byDay.get(`${e.id}:${d}`);
      if (status) c[status as 'present'] += 1;
      else if (weeklyOff.includes(weekdayOf(d))) c.autoOff += 1;
      else c.notMarked += 1;
    }
    const monthlySalary = salaryForMonth(revisions.filter((r) => r.employee_id === e.id), from, to, days);
    if (D(monthlySalary).lte(0)) continue;
    const entitled = leaveEntitlement(e.annualLeaveDays === null ? leavePolicy : Number(e.annualLeaveDays), e.joinDate, leaveYear);
    const paidLeave = Math.max(0, Math.min(c.leave, entitled - (leaveBefore.get(e.id) ?? 0)));
    const unpaidLeave = c.leave - paidLeave;
    const paidDays = c.present + 0.5 * c.half_day + paidLeave + c.weekly_off + c.holiday + c.autoOff;
    const old = kept.get(e.id);
    const pay = computePay({
      monthlySalary, daysInMonth: days, paidDays, pf: e.pfApplicable, esic: e.esicApplicable, ptMonthly: e.ptMonthly, tdsMonthly: e.tdsMonthly,
      otherEarning: old?.otherEarning ?? '0', otherDeduction: old?.otherDeduction ?? '0',
      advanceDue: money(due.filter((a) => a.employee_id === e.id).reduce((s, a) => s.plus(a.due), D(0))),
    }, rules);
    const values = {
      employeeName: e.name, employeeNo: e.employeeNo, department: e.department, designation: e.designation, bankAccountNo: e.bankAccountNo, bankIfsc: e.bankIfsc,
      monthlySalary, daysInMonth: days, paidDays: paidDays.toFixed(1), present: c.present, halfDays: c.half_day, leaveDays: c.leave, unpaidLeave: unpaidLeave.toFixed(1),
      weeklyOff: c.weekly_off + c.autoOff, holidays: c.holiday, absent: c.absent, notMarked: c.notMarked,
      grossEarned: pay.grossEarned, basicEarned: pay.basicEarned, allowanceEarned: pay.allowanceEarned, pfEmployee: pay.pfEmployee, pfEmployer: pay.pfEmployer,
      esicEmployee: pay.esicEmployee, esicEmployer: pay.esicEmployer, pt: pay.pt, tds: pay.tds, advanceRecovery: pay.advanceRecovery, netPay: pay.netPay, updatedAt: new Date(),
    };
    if (old) await tx.update(payslips).set(values).where(eq(payslips.id, old.id));
    else await tx.insert(payslips).values({ ...values, runId: run.id, employeeId: e.id, createdBy: ctx.user?.id ?? null });
    seen.push(e.id);
  }
  // Someone whose salary was removed, or who turned out not to be on the rolls that month, drops out of the run.
  for (const [employeeId, slip] of kept) if (!seen.includes(employeeId)) await tx.delete(payslips).where(eq(payslips.id, slip.id));
}

// ---------------------------------------------------------------------------
// Approving, reopening and paying
// ---------------------------------------------------------------------------
const sum = (slips: Slip[], pick: (s: Slip) => string) => slips.reduce((a, s) => a.plus(pick(s)), D(0));

/** Put the month's salary in the books and take the advances off. From here the payslips are fixed. */
export async function approveRun(ctx: Ctx, id: string, opts: { evenIfUnmarked?: boolean } = {}): Promise<Run> {
  const { tx } = ctx;
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  must(run, 'Salary run');
  await calculateRun(ctx, run!); // from the register as it is at this moment
  await assertNotOwnPay(ctx, id, 'approve');
  const slips = await tx.select().from(payslips).where(eq(payslips.runId, id));
  if (slips.length === 0) throw badRequest('Nobody has a salary set, so there is nothing to approve');
  const unmarked = slips.filter((s) => s.notMarked > 0);
  if (unmarked.length > 0 && !opts.evenIfUnmarked) {
    throw conflict(
      `${unmarked.length} ${unmarked.length === 1 ? 'person has' : 'people have'} working days nobody marked in the register (${unmarked.slice(0, 3).map((s) => `${s.employeeName}: ${s.notMarked}`).join(', ')}${unmarked.length > 3 ? ', …' : ''}). Those days are not paid. Complete the register, or approve as it is.`,
      { unmarked: unmarked.map((s) => ({ employee: s.employeeName, days: s.notMarked })) });
  }
  const short = slips.find((s) => D(s.netPay).lt(0));
  if (short) throw conflict(`${short.employeeName}'s deductions come to more than the salary earned. Reduce a deduction first.`);

  const { to } = monthSpan(run!.month);
  const today = istDate();
  const bookedOn = to < today ? to : today;
  const employerCost = sum(slips, (s) => s.pfEmployer).plus(sum(slips, (s) => s.esicEmployer));
  await postJournal(ctx, {
    date: bookedOn, refType: 'payroll', refId: id, narration: `Salaries for ${monthName(run!.month)} (${slips.length} ${slips.length === 1 ? 'person' : 'people'})`,
    lines: [
      { account: 'salaries', debit: money(sum(slips, (s) => s.grossEarned).plus(sum(slips, (s) => s.otherEarning)).minus(sum(slips, (s) => s.otherDeduction)).plus(employerCost)) },
      { account: 'pf_payable', credit: money(sum(slips, (s) => s.pfEmployee).plus(sum(slips, (s) => s.pfEmployer))) },
      { account: 'esic_payable', credit: money(sum(slips, (s) => s.esicEmployee).plus(sum(slips, (s) => s.esicEmployer))) },
      { account: 'pt_payable', credit: money(sum(slips, (s) => s.pt)) },
      { account: 'tds_payable', credit: money(sum(slips, (s) => s.tds)) },
      { account: 'staff_advances', credit: money(sum(slips, (s) => s.advanceRecovery)) },
      { account: 'salaries_payable', credit: money(sum(slips, (s) => s.netPay)) },
    ],
  });
  // What was recovered is set against each person's advances, the oldest first.
  const due = await advancesDue(tx, to);
  for (const s of slips) {
    let left = D(s.advanceRecovery);
    for (const a of due.filter((x) => x.employee_id === s.employeeId)) {
      if (left.lte(0)) break;
      const take = D(a.due).lt(left) ? D(a.due) : left;
      await tx.insert(advanceRecoveries).values({ advanceId: a.id, payslipId: s.id, amount: money(take) });
      left = left.minus(take);
    }
  }
  const [updated] = await tx.update(payrollRuns)
    .set({ status: 'approved', bookedOn, approvedBy: ctx.user!.id, approvedAt: new Date(), updatedAt: new Date() }).where(eq(payrollRuns.id, id)).returning();
  await audit(ctx, 'payroll_run', id, 'approve', { status: 'draft' }, { status: 'approved', people: slips.length, net: money(sum(slips, (s) => s.netPay)) });
  return updated!;
}

/** Take an approved month back to draft to correct it. The entry is reversed and the advances are owed again. */
export async function reopenRun(ctx: Ctx, id: string): Promise<Run> {
  const { tx } = ctx;
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  must(run, 'Salary run');
  if (run!.status === 'paid') throw conflict('These salaries have been paid. Correct the difference in next month\'s run, as an addition or a deduction.');
  if (run!.status !== 'approved') throw conflict('Only an approved month can be reopened');
  await assertNotOwnPay(ctx, id, 'reopen');
  await reverseJournals(ctx, 'payroll', id, istDate(), `Reopened: salaries for ${monthName(run!.month)}`);
  await tx.execute(sql`delete from advance_recoveries where payslip_id in (select id from payslips where run_id = ${id})`);
  const [updated] = await tx.update(payrollRuns).set({ status: 'draft', bookedOn: null, approvedBy: null, approvedAt: null, updatedAt: new Date() }).where(eq(payrollRuns.id, id)).returning();
  await audit(ctx, 'payroll_run', id, 'reopen', { status: 'approved' }, { status: 'draft' });
  return updated!;
}

/** Record that the net salaries of an approved month went out of a bank or cash account. */
export async function payRun(ctx: Ctx, id: string, input: { accountId: string; paidOn: string; reference?: string | null }): Promise<Run> {
  const { tx } = ctx;
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  must(run, 'Salary run');
  if (run!.status !== 'approved') throw conflict(run!.status === 'paid' ? 'These salaries have already been paid' : 'Approve the salaries before paying them');
  await assertNotOwnPay(ctx, id, 'record the payment of');
  await assertMoneyAccount(tx, input.accountId);
  const slips = await tx.select().from(payslips).where(eq(payslips.runId, id));
  const net = sum(slips, (s) => s.netPay);
  await postJournal(ctx, {
    date: input.paidOn, refType: 'payroll_payment', refId: id,
    narration: `Salaries paid for ${monthName(run!.month)}${input.reference ? ` (${input.reference})` : ''}`,
    lines: [{ account: 'salaries_payable', debit: money(net) }, { account: { id: input.accountId }, credit: money(net) }],
  });
  const [updated] = await tx.update(payrollRuns)
    .set({ status: 'paid', paidOn: input.paidOn, paidFromAccountId: input.accountId, paymentReference: input.reference ?? null, updatedAt: new Date() })
    .where(eq(payrollRuns.id, id)).returning();
  await audit(ctx, 'payroll_run', id, 'pay', { status: 'approved' }, { status: 'paid', net: money(net), paidOn: input.paidOn });
  return updated!;
}

// ---------------------------------------------------------------------------
// The payslip as a document, and the routes
// ---------------------------------------------------------------------------
/** A payslip as a document: the figures, the month in words, and whose it is. */
async function payslipDocument(tx: DB, slip: Slip) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, slip.runId));
  const deductions = D(slip.pfEmployee).plus(slip.esicEmployee).plus(slip.pt).plus(slip.tds).plus(slip.advanceRecovery).plus(slip.otherDeduction);
  return {
    ...slip, token: undefined, tokenExpiresAt: undefined, month: run!.month, month_name: monthName(run!.month), run_status: run!.status, paid_on: run!.paidOn,
    total_earnings: money(D(slip.grossEarned).plus(slip.otherEarning)), total_deductions: money(deductions),
    net_in_words: amountInWords(slip.netPay), company: await getCompany(tx),
  };
}

export function payrollRouter(db: DB) {
  const r = Router();

  /** A person's own payslips, once the month is approved. */
  r.get('/me', requireAuth, async (req, res) => {
    res.json({ data: await rows(db, sql`
      select s.id, r.month, s.net_pay, s.paid_days, s.days_in_month, r.status, r.paid_on
        from payslips s join payroll_runs r on r.id = s.run_id join employees e on e.id = s.employee_id
       where e.user_id = ${req.user!.id} and r.status in ('approved', 'paid') order by r.month desc limit 24`) });
  });

  // ---- who is paid what ------------------------------------------------------
  r.get('/staff', requirePerm('payroll:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select e.id, e.employee_no, e.name, e.department, e.designation, e.status, e.monthly_salary, e.pf_applicable, e.esic_applicable,
             e.pt_monthly, e.tds_monthly, e.bank_account_no, e.bank_ifsc,
             coalesce((select sum(a.amount - coalesce((select sum(x.amount) from advance_recoveries x where x.advance_id = a.id), 0))
                         from salary_advances a where a.employee_id = e.id and a.cancelled_at is null), 0)::numeric(12,2) as advance_outstanding
        from employees e where e.status = 'active' order by e.department, e.name`) });
  });

  r.put('/staff/:id', requirePerm('employees:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      monthly_salary: emptyToNull(zMoney).nullable(), pf_applicable: z.boolean(), esic_applicable: z.boolean(), pt_monthly: zMoney, tds_monthly: zMoney,
      salary_from: zDate.optional(),
      bank_account_no: emptyToNull(z.string().trim().regex(/^\d{6,20}$/, 'must be 6 to 20 digits')).nullable(),
      bank_ifsc: emptyToNull(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must look like HDFC0001234')).nullable(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(employees).where(eq(employees.id, id)).for('update');
      must(before, 'Employee');
      await recordSalary(ctx, before!, b.monthly_salary, b.salary_from ?? istDate());
      const [after] = await ctx.tx.update(employees).set({
        monthlySalary: b.monthly_salary, pfApplicable: b.pf_applicable, esicApplicable: b.esic_applicable, ptMonthly: b.pt_monthly, tdsMonthly: b.tds_monthly,
        bankAccountNo: b.bank_account_no, bankIfsc: b.bank_ifsc, updatedAt: new Date(),
      }).where(eq(employees.id, id)).returning();
      await audit(ctx, 'employee', id, 'pay_details',
        { monthlySalary: before!.monthlySalary, pf: before!.pfApplicable, esic: before!.esicApplicable, pt: before!.ptMonthly, tds: before!.tdsMonthly },
        { monthlySalary: after!.monthlySalary, pf: after!.pfApplicable, esic: after!.esicApplicable, pt: after!.ptMonthly, tds: after!.tdsMonthly });
      return after;
    });
    res.json({ data: row });
  });

  r.get('/rules', requirePerm('payroll:read'), async (_req, res) => {
    res.json({ data: await getSetting(db, 'payroll_rules') });
  });

  r.put('/rules', requirePerm('payroll:manage'), async (req, res) => {
    const pct = z.coerce.number().min(0).max(100);
    const b: PayrollRules = z.object({
      basic_pct: pct, pf_rate: pct, pf_wage_ceiling: z.coerce.number().min(0).max(10_000_000), esic_employee_rate: pct, esic_employer_rate: pct,
      esic_gross_limit: z.coerce.number().min(0).max(10_000_000),
    }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'payroll_rules');
      await setSetting(ctx.tx, 'payroll_rules', b, ctx.user!.id);
      await audit(ctx, 'settings', 'payroll_rules', 'update', before, b);
    });
    res.json({ data: b });
  });

  // ---- advances ----------------------------------------------------------------
  r.get('/advances', requirePerm('payroll:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select a.id, a.employee_id, e.name, e.employee_no, a.given_on, a.amount, a.monthly_recovery, a.note, a.cancelled_at, acc.name as paid_from,
             coalesce(r.recovered, 0)::numeric(12,2) as recovered, (a.amount - coalesce(r.recovered, 0))::numeric(12,2) as outstanding
        from salary_advances a join employees e on e.id = a.employee_id join accounts acc on acc.id = a.paid_from_account_id
        left join (select advance_id, sum(amount) as recovered from advance_recoveries group by advance_id) r on r.advance_id = a.id
       order by (a.cancelled_at is null and a.amount - coalesce(r.recovered, 0) > 0) desc, a.given_on desc limit 300`) });
  });

  r.post('/advances', requirePerm('payroll:manage'), async (req, res) => {
    const b = z.object({
      employee_id: zId, amount: zMoneyPos, monthly_recovery: zMoneyPos, given_on: zDate.default(() => istDate()), paid_from_account_id: zId,
      note: emptyToNull(z.string().trim().max(300)).optional(),
    }).parse(req.body);
    if (D(b.monthly_recovery).gt(b.amount)) throw badRequest('The amount taken back each month cannot be more than the advance itself');
    const row = await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(employees).where(eq(employees.id, b.employee_id));
      if (!e || e.status !== 'active') throw badRequest('That person is not on the rolls');
      await assertMoneyAccount(ctx.tx, b.paid_from_account_id);
      const [made] = await ctx.tx.insert(salaryAdvances).values({
        employeeId: b.employee_id, amount: b.amount, monthlyRecovery: b.monthly_recovery, givenOn: b.given_on, paidFromAccountId: b.paid_from_account_id,
        note: b.note ?? null, createdBy: ctx.user!.id,
      }).returning();
      await postJournal(ctx, {
        date: b.given_on, refType: 'salary_advance', refId: made!.id, narration: `Advance to ${e.name} (${e.employeeNo})${b.note ? `: ${b.note}` : ''}`,
        lines: [{ account: 'staff_advances', debit: b.amount }, { account: { id: b.paid_from_account_id }, credit: b.amount }],
      });
      await audit(ctx, 'salary_advance', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });

  /** Entered by mistake: take it back out of the books. Not possible once any of it has been recovered. */
  r.post('/advances/:id/cancel', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(salaryAdvances).where(eq(salaryAdvances.id, id)).for('update');
      must(a, 'Advance');
      if (a!.cancelledAt) throw conflict('This advance was already cancelled');
      const [used] = await ctx.tx.select({ id: advanceRecoveries.id }).from(advanceRecoveries).where(eq(advanceRecoveries.advanceId, id)).limit(1);
      if (used) throw conflict('Part of this advance has already been taken back from a salary, so it cannot be cancelled');
      await reverseJournals(ctx, 'salary_advance', id, istDate(), 'Advance cancelled');
      await ctx.tx.update(salaryAdvances).set({ cancelledAt: new Date(), updatedAt: new Date() }).where(eq(salaryAdvances.id, id));
      await audit(ctx, 'salary_advance', id, 'cancel', null, { cancelled: true });
    });
    res.json({ ok: true });
  });

  // ---- the month's salary ----------------------------------------------------------
  r.get('/runs', requirePerm('payroll:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select r.id, r.month, r.status, r.booked_on, r.paid_on, count(s.id)::int as people,
             coalesce(sum(s.gross_earned + s.other_earning), 0)::numeric(14,2) as earnings, coalesce(sum(s.net_pay), 0)::numeric(14,2) as net_pay,
             coalesce(sum(s.not_marked), 0)::int as not_marked
        from payroll_runs r left join payslips s on s.run_id = r.id group by r.id order by r.month desc limit 60`) });
  });

  r.post('/runs', requirePerm('payroll:manage'), async (req, res) => {
    const b = z.object({ month: zMonth }).parse(req.body);
    if (b.month > istDate().slice(0, 7)) throw badRequest('That month has not started yet');
    const run = await inTx(db, req, async (ctx) => {
      const [made] = await ctx.tx.insert(payrollRuns).values({ month: b.month, createdBy: ctx.user!.id }).onConflictDoNothing().returning();
      if (!made) throw conflict(`The salary for ${monthName(b.month)} has already been started`);
      await calculateRun(ctx, made);
      await audit(ctx, 'payroll_run', made.id, 'create', null, { month: b.month });
      return made;
    });
    res.status(201).json({ data: run });
  });

  r.get('/runs/:id', requirePerm('payroll:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id));
    must(run, 'Salary run');
    const slips = await db.select().from(payslips).where(eq(payslips.runId, id)).orderBy(asc(payslips.department), asc(payslips.employeeName));
    const t = (pick: (s: Slip) => string) => money(sum(slips, pick));
    res.json({
      data: {
        ...run, month_name: monthName(run!.month), payslips: slips.map((s) => ({ ...s, token: undefined })),
        totals: {
          earnings: money(sum(slips, (s) => s.grossEarned).plus(sum(slips, (s) => s.otherEarning))), pf: t((s) => s.pfEmployee), esic: t((s) => s.esicEmployee), pt: t((s) => s.pt),
          tds: t((s) => s.tds), advances: t((s) => s.advanceRecovery), other_deductions: t((s) => s.otherDeduction), net_pay: t((s) => s.netPay),
          employer_pf: t((s) => s.pfEmployer), employer_esic: t((s) => s.esicEmployer),
          cost_to_company: money(sum(slips, (s) => s.grossEarned).plus(sum(slips, (s) => s.otherEarning)).minus(sum(slips, (s) => s.otherDeduction)).plus(sum(slips, (s) => s.pfEmployer)).plus(sum(slips, (s) => s.esicEmployer))),
          not_marked: slips.reduce((n, s) => n + s.notMarked, 0),
        },
        // People on the rolls that month who are left out because no salary is set for them.
        no_salary: await rows(db, sql`
          select e.id, e.name, e.employee_no from employees e
           where (e.monthly_salary is null or e.monthly_salary = 0) and e.join_date <= ${monthSpan(run!.month).to}::date
             and (e.left_on is null or e.left_on >= ${monthSpan(run!.month).from}::date) order by e.name`),
      },
    });
  });

  r.post('/runs/:id/recalculate', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [run] = await ctx.tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
      must(run, 'Salary run');
      await calculateRun(ctx, run!);
    });
    res.json({ ok: true });
  });

  /** A bonus or arrears to add, or a fine or other amount to take off, for one person this month. */
  r.patch('/payslips/:id', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ other_earning: zMoney, other_deduction: zMoney, note: emptyToNull(z.string().trim().max(300)).nullable() }).parse(req.body);
    if ((D(b.other_earning).gt(0) || D(b.other_deduction).gt(0)) && !b.note) throw badRequest('Say what the addition or deduction is for; it is printed on the payslip');
    await inTx(db, req, async (ctx) => {
      const [slip] = await ctx.tx.select().from(payslips).where(eq(payslips.id, id)).for('update');
      must(slip, 'Payslip');
      const [run] = await ctx.tx.select().from(payrollRuns).where(eq(payrollRuns.id, slip!.runId)).for('update');
      const [own] = await ctx.tx.select({ id: employees.id }).from(employees).where(and(eq(employees.id, slip!.employeeId), eq(employees.userId, ctx.user!.id)));
      if (own) throw forbidden('Someone else must add to or take off your own salary');
      await ctx.tx.update(payslips).set({ otherEarning: b.other_earning, otherDeduction: b.other_deduction, note: b.note, updatedAt: new Date() }).where(eq(payslips.id, id));
      await calculateRun(ctx, run!);
      await audit(ctx, 'payslip', id, 'adjust', { otherEarning: slip!.otherEarning, otherDeduction: slip!.otherDeduction }, { otherEarning: b.other_earning, otherDeduction: b.other_deduction, note: b.note });
    });
    res.json({ ok: true });
  });

  r.post('/runs/:id/approve', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ even_if_unmarked: z.boolean().default(false) }).parse(req.body ?? {});
    res.json({ data: await inTx(db, req, (ctx) => approveRun(ctx, id, { evenIfUnmarked: b.even_if_unmarked })) });
  });

  r.post('/runs/:id/reopen', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    res.json({ data: await inTx(db, req, (ctx) => reopenRun(ctx, id)) });
  });

  r.post('/runs/:id/pay', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ paid_from_account_id: zId, paid_on: zDate.default(() => istDate()), reference: emptyToNull(z.string().trim().max(100)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => payRun(ctx, id, { accountId: b.paid_from_account_id, paidOn: b.paid_on, reference: b.reference })) });
  });

  /** A month started by mistake, while it is still a draft. */
  r.delete('/runs/:id', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [run] = await ctx.tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
      must(run, 'Salary run');
      if (run!.status !== 'draft') throw conflict('Only a draft can be removed. Reopen it first.');
      await ctx.tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      await audit(ctx, 'payroll_run', id, 'delete', { month: run!.month }, null);
    });
    res.json({ ok: true });
  });

  /** The list the bank needs to send the salaries: name, account, IFSC, amount. */
  r.get('/runs/:id/bank-file', requirePerm('payroll:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id));
    must(run, 'Salary run');
    const data = await rows(db, sql`
      select s.employee_no, s.employee_name as name, s.bank_account_no as account_no, s.bank_ifsc as ifsc, s.net_pay as amount,
             ${`Salary ${monthName(run!.month)}`}::text as remarks
        from payslips s where s.run_id = ${id} and s.net_pay > 0 order by s.employee_name`);
    if (wantsFile(req)) return sendList(req, res, data, `salary-bank-list-${run!.month}`);
    res.json({ data });
  });

  r.get('/payslips/:id', requirePerm('payroll:read'), async (req, res) => {
    const [slip] = await db.select().from(payslips).where(eq(payslips.id, zId.parse(req.params.id)));
    must(slip, 'Payslip');
    res.json({ data: await payslipDocument(db, slip!) });
  });

  /** The link the person opens to see their payslip. Only once the month is approved. */
  r.post('/payslips/:id/share', requirePerm('payroll:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const out = await inTx(db, req, async (ctx) => {
      const [slip] = await ctx.tx.select().from(payslips).where(eq(payslips.id, id)).for('update');
      must(slip, 'Payslip');
      const [run] = await ctx.tx.select().from(payrollRuns).where(eq(payrollRuns.id, slip!.runId));
      if (run!.status === 'draft') throw conflict('Approve the salaries first; a draft payslip can still change');
      // A link lasts PAYSLIP_LINK_DAYS (technical review, 26 Oct 2026: links "never expire"). Sent again while it
      // still works, the same link goes; after that, a new one, and the old one stops working.
      const live = slip!.token && slip!.tokenExpiresAt && slip!.tokenExpiresAt > new Date();
      const token = live ? slip!.token! : crypto.randomBytes(16).toString('base64url');
      if (!live) {
        await ctx.tx.update(payslips).set({ token, tokenExpiresAt: new Date(Date.now() + PAYSLIP_LINK_DAYS * 86_400_000) }).where(eq(payslips.id, id));
      }
      const [e] = await ctx.tx.select({ phone: employees.phone }).from(employees).where(eq(employees.id, slip!.employeeId));
      return { token, phone: e?.phone ?? null, name: slip!.employeeName, month_name: monthName(run!.month), net_pay: slip!.netPay };
    });
    res.json({ data: { ...out, path: `/p/${out.token}` } });
  });

  return r;
}

/** How long a payslip link sent on WhatsApp keeps working. */
export const PAYSLIP_LINK_DAYS = 30;

// ---------------------------------------------------------------------------
// Payslips as their owner sees them
// ---------------------------------------------------------------------------
/** A person's own payslips as they see them on "My work": the ones for their sign-in, opened by id. */
export function myPayslipRouter(db: DB) {
  const r = Router();
  r.get('/:id', requireAuth, async (req, res) => {
    const [slip] = await db.select().from(payslips).where(eq(payslips.id, zId.parse(req.params.id)));
    const [mine] = slip ? await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, slip.employeeId), eq(employees.userId, req.user!.id))) : [];
    const [run] = slip ? await db.select().from(payrollRuns).where(eq(payrollRuns.id, slip.runId)) : [];
    if (!slip || !mine || run!.status === 'draft') throw must(null, 'Payslip');
    res.json({ data: await payslipDocument(db, slip) });
  });
  return r;
}

/** The payslip as the person sees it when they open the link sent to them. */
export function publicPayslipRouter(db: DB) {
  const r = Router();
  r.get('/:token', async (req, res) => {
    const [slip] = await db.select().from(payslips).where(eq(payslips.token, String(req.params.token)));
    if (!slip) throw must(null, 'This link');
    if (!slip.tokenExpiresAt || slip.tokenExpiresAt <= new Date()) throw new AppError(410, 'expired', 'This payslip link has expired. Ask HR to send it again.');
    const doc = await payslipDocument(db, slip);
    // A month taken back to draft is being corrected: its payslips are not shown until it is approved again.
    if (doc.run_status === 'draft') throw must(null, 'This link');
    // A forwarded link must not give away the bank account: only its last four digits show.
    const bank = slip.bankAccountNo ? `${'•'.repeat(Math.max(0, slip.bankAccountNo.length - 4))}${slip.bankAccountNo.slice(-4)}` : null;
    res.json({ data: { ...doc, bankAccountNo: bank, tokenExpiresAt: undefined, createdBy: undefined, runId: undefined, employeeId: undefined } });
  });
  return r;
}
