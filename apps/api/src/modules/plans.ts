import { and, desc, eq } from 'drizzle-orm';
import { rows, sql, type DB } from '../db/client';
import { followUpPlans, leadActivities, leads, messageTemplates } from '../db/schema';
import { badRequest, must } from '../lib/errors';
import type { Ctx } from '../lib/http';

/**
 * Follow-up plans: a list of steps over days and weeks ("day 0: first hello, day 2: follow up,
 * day 7: last check"). A lead on a plan is always due on the day of its next step, with that
 * step's message one tap away. Contacting the lead on or after that day does the step and moves
 * the lead on to the next; contacting it earlier is just an extra contact. The plan stops by
 * itself when the lead replies, is won or is lost.
 */
export type PlanStep = { after_days: number; what: string; template_id: string | null };
type Lead = typeof leads.$inferSelect;

const DAY = 86_400_000;
const dueOf = (startedAt: Date, step: PlanStep) => new Date(startedAt.getTime() + step.after_days * DAY);
const later = (a: Date, b: Date) => (a > b ? a : b);

async function note(ctx: Ctx, leadId: string, text: string) {
  await ctx.tx.insert(leadActivities).values({ leadId, type: 'note', note: text, userId: ctx.user?.id ?? null });
}

/** Put a lead on a plan, from its first step. The follow-up date becomes the day that step is due. */
export async function startPlan(ctx: Ctx, leadId: string, planId: string): Promise<void> {
  const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, leadId)).for('update');
  must(lead, 'Lead');
  if (lead!.stage === 'converted' || lead!.stage === 'lost') throw badRequest('This lead is closed, so there is nothing to follow up');
  const [plan] = await ctx.tx.select().from(followUpPlans).where(eq(followUpPlans.id, planId));
  if (!plan || !plan.active) throw badRequest('That plan is not available');
  const steps = plan.steps as PlanStep[];
  const startedAt = new Date();
  await ctx.tx.update(leads)
    .set({ planId, planStep: 0, planStartedAt: startedAt, nextFollowUpAt: later(dueOf(startedAt, steps[0]!), startedAt), updatedAt: new Date() })
    .where(eq(leads.id, leadId));
  await note(ctx, leadId, `Started the follow-up plan "${plan.name}"`);
}

/** A new lead goes onto the plan marked as the usual one, when there is one. */
export async function startDefaultPlan(ctx: Ctx, leadId: string): Promise<void> {
  const [plan] = await ctx.tx.select({ id: followUpPlans.id }).from(followUpPlans)
    .where(and(eq(followUpPlans.isDefault, true), eq(followUpPlans.active, true))).orderBy(desc(followUpPlans.createdAt)).limit(1);
  if (plan) await startPlan(ctx, leadId, plan.id);
}

/** Take a lead off its plan. `why` is written on the lead when given (it replied, it was won or lost). */
export async function stopPlan(ctx: Ctx, leadId: string, why: string | null): Promise<void> {
  const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, leadId)).for('update');
  if (!lead?.planId) return;
  await ctx.tx.update(leads).set({ planId: null, planStep: null, planStartedAt: null, updatedAt: new Date() }).where(eq(leads.id, leadId));
  if (why) await note(ctx, leadId, `Follow-up plan stopped: ${why}`);
}

/**
 * We have just contacted the lead. If the step it was waiting on had come due, that step is done:
 * move to the next one and set the follow-up to its day. `keepFollowUp` leaves the follow-up date
 * alone when the person has just chosen one themselves.
 */
export async function advancePlan(ctx: Ctx, leadId: string, opts: { keepFollowUp?: boolean } = {}): Promise<void> {
  const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, leadId)).for('update');
  if (!lead?.planId || lead.planStep === null || !lead.planStartedAt) return;
  const [plan] = await ctx.tx.select().from(followUpPlans).where(eq(followUpPlans.id, lead.planId));
  const steps = (plan?.steps ?? []) as PlanStep[];
  const current = steps[lead.planStep];
  if (!plan || !current) return stopPlan(ctx, leadId, null);
  if (new Date() < dueOf(lead.planStartedAt, current)) return; // early: an extra contact, the step still stands
  const next = steps[lead.planStep + 1];
  if (!next) {
    await ctx.tx.update(leads).set({ planId: null, planStep: null, planStartedAt: null, updatedAt: new Date() }).where(eq(leads.id, leadId));
    await note(ctx, leadId, `Finished the follow-up plan "${plan.name}"`);
    return;
  }
  await ctx.tx.update(leads).set({
    planStep: lead.planStep + 1, updatedAt: new Date(),
    ...(opts.keepFollowUp ? {} : { nextFollowUpAt: later(dueOf(lead.planStartedAt, next), new Date()) }),
  }).where(eq(leads.id, leadId));
}

/** The plan as the lead's page shows it: every step with its day, and which one is next. */
export async function planView(tx: DB, lead: Pick<Lead, 'planId' | 'planStep' | 'planStartedAt'>) {
  if (!lead.planId || lead.planStep === null || !lead.planStartedAt) return null;
  const [plan] = await tx.select().from(followUpPlans).where(eq(followUpPlans.id, lead.planId));
  if (!plan) return null;
  const names = new Map((await tx.select({ id: messageTemplates.id, name: messageTemplates.name }).from(messageTemplates)).map((t) => [t.id, t.name]));
  const started = new Date(lead.planStartedAt);
  return {
    id: plan.id, name: plan.name, step: lead.planStep,
    steps: (plan.steps as PlanStep[]).map((s, i) => ({
      ...s, template_name: s.template_id ? names.get(s.template_id) ?? null : null, due_at: dueOf(started, s).toISOString(),
      state: i < lead.planStep! ? 'done' : i === lead.planStep ? 'now' : 'later',
    })),
  };
}

/** How many leads are on each plan right now. */
export async function plansWithCounts(db: DB) {
  return rows(db, sql`
    select p.*, (select count(*)::int from leads l where l.plan_id = p.id) as leads_on_it
      from follow_up_plans p order by p.active desc, p.is_default desc, p.name`);
}
