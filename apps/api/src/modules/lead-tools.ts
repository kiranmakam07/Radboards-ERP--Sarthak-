import { eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { normalisePhone } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import type { DB } from '../db/client';
import { followUpPlans, leadSources, leads, messageTemplates, users } from '../db/schema';
import { parseCsv } from '../lib/bank-csv';
import { badRequest, must } from '../lib/errors';
import { emptyToNull, inTx, zId, zText } from '../lib/http';
import { captureLead } from './leads';
import { plansWithCounts, startPlan, stopPlan, type PlanStep } from './plans';
import { OPEN_STAGES } from '../core/stages';

/**
 * Working leads in numbers rather than one at a time: bringing a list in from a spreadsheet,
 * handing many leads to someone at once, and the follow-up plans that leads are put on.
 */

const key = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
const COLUMNS: Record<string, string[]> = {
  name: ['name', 'fullname', 'customername', 'leadname', 'contactname', 'customer'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'number', 'contact', 'contactnumber', 'whatsapp', 'mobileno', 'phoneno'],
  email: ['email', 'emailaddress', 'mail'],
  notes: ['notes', 'note', 'message', 'remarks', 'comment', 'comments', 'requirement', 'city'],
};

const zStep = z.object({
  after_days: z.coerce.number().int().min(0).max(365),
  what: zText(120),
  template_id: emptyToNull(zId).nullish().transform((v) => v ?? null),
});
const zPlan = z.object({
  name: zText(80),
  steps: z.array(zStep).min(1, 'a plan needs at least one step').max(20),
  is_default: z.boolean().default(false),
  active: z.boolean().default(true),
});

async function checkedSteps(db: DB, steps: PlanStep[]): Promise<PlanStep[]> {
  const sorted = [...steps].sort((a, b) => a.after_days - b.after_days);
  const ids = sorted.map((s) => s.template_id).filter((v): v is string => Boolean(v));
  if (ids.length > 0) {
    const found = await db.select({ id: messageTemplates.id }).from(messageTemplates).where(inArray(messageTemplates.id, ids));
    if (found.length !== new Set(ids).size) throw badRequest('One of the quick replies in the plan does not exist');
  }
  return sorted;
}

export function leadToolsRouter(db: DB) {
  const r = Router();

  /**
   * A list of leads from a spreadsheet (saved as CSV): a name and a phone number per row, with
   * email and notes if there. A number already here is not added again; the row is noted on
   * that lead as a repeat enquiry. Rows that cannot be read are listed, the rest still come in.
   */
  r.post('/import', requirePerm('crm:manage'), async (req, res) => {
    const b = z.object({
      csv: z.string().min(1, 'the file is empty'), source_id: zId, source_detail: emptyToNull(z.string().trim().max(200)).optional(),
      owner_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const [source] = await db.select().from(leadSources).where(eq(leadSources.id, b.source_id));
    if (!source) throw badRequest('Unknown lead source');
    const table = parseCsv(b.csv);
    const header = (table[0] ?? []).map(key);
    const at = (field: string) => COLUMNS[field]!.map((n) => header.indexOf(n)).find((i) => i >= 0);
    const [iName, iPhone, iEmail, iNotes] = [at('name'), at('phone'), at('email'), at('notes')];
    if (iPhone === undefined) {
      throw badRequest(`No phone column was found. The first row must name the columns, one of them "Phone" or "Mobile". Columns found: ${(table[0] ?? []).slice(0, 10).join(', ') || 'none'}.`);
    }
    const body = table.slice(1).filter((row) => row.some((c) => c.trim()));
    if (body.length > 2000) throw badRequest('That is more than 2,000 rows. Bring them in as two or more files.');
    const out = { rows: body.length, added: 0, already_here: 0, problems: [] as { row: number; message: string }[] };
    for (const [n, row] of body.entries()) {
      const phone = normalisePhone(row[iPhone] ?? '');
      const name = (iName === undefined ? '' : (row[iName] ?? '')).trim().slice(0, 150);
      if (!phone) {
        out.problems.push({ row: n + 2, message: `"${(row[iPhone] ?? '').trim()}" is not an Indian mobile number` });
        continue;
      }
      const email = iEmail === undefined ? '' : (row[iEmail] ?? '').trim().toLowerCase();
      try {
        // A row at a time, each in its own transaction: one bad row does not hold back the others.
        const result = await inTx(db, req, (ctx) => captureLead(ctx, {
          name: name || 'Imported lead', phone, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 200) : null,
          sourceId: b.source_id, sourceDetail: b.source_detail ?? null, ownerId: b.owner_id ?? null,
          notes: iNotes === undefined ? null : (row[iNotes] ?? '').trim().slice(0, 2000) || null,
        }));
        if (result.duplicate) out.already_here++;
        else out.added++;
      } catch (e) {
        out.problems.push({ row: n + 2, message: (e as Error).message });
      }
    }
    res.status(201).json({ data: out });
  });

  /** Hand many leads to one person in one go. Closed leads are left where they are. */
  r.post('/bulk-assign', requirePerm('crm:manage'), async (req, res) => {
    const b = z.object({ ids: z.array(zId).min(1).max(500), owner_id: zId }).parse(req.body);
    const moved = await inTx(db, req, async (ctx) => {
      const [owner] = await ctx.tx.select().from(users).where(eq(users.id, b.owner_id));
      if (!owner || !owner.active) throw badRequest('That person does not have an active sign-in');
      const changed = await ctx.tx.update(leads).set({ ownerId: b.owner_id, updatedAt: new Date() })
        .where(sql`${inArray(leads.id, b.ids)} and ${leads.stage} in (${OPEN_STAGES}) and ${leads.ownerId} is distinct from ${b.owner_id}`)
        .returning({ id: leads.id });
      await audit(ctx, 'lead', 'bulk', 'bulk_assign', null, { owner_id: b.owner_id, owner: owner.name, leads: changed.map((c) => c.id) });
      return { moved: changed.length, owner: owner.name };
    });
    res.json({ data: moved });
  });

  // ---- follow-up plans -------------------------------------------------------
  r.get('/plans', requirePerm('leads:read'), async (_req, res) => {
    res.json({ data: await plansWithCounts(db) });
  });

  r.post('/plans', requirePerm('crm:manage'), async (req, res) => {
    const b = zPlan.parse(req.body);
    const steps = await checkedSteps(db, b.steps);
    const row = await inTx(db, req, async (ctx) => {
      // Only one plan is the usual one for new leads.
      if (b.is_default) await ctx.tx.update(followUpPlans).set({ isDefault: false });
      const [made] = await ctx.tx.insert(followUpPlans).values({ name: b.name, steps, isDefault: b.is_default, active: b.active, createdBy: ctx.user!.id }).returning();
      await audit(ctx, 'follow_up_plan', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });

  r.patch('/plans/:id', requirePerm('crm:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zPlan.partial().parse(req.body);
    const steps = b.steps ? await checkedSteps(db, b.steps) : undefined;
    const row = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(followUpPlans).where(eq(followUpPlans.id, id)).for('update');
      must(before, 'Plan');
      if (b.is_default) await ctx.tx.update(followUpPlans).set({ isDefault: false });
      const [after] = await ctx.tx.update(followUpPlans).set({
        ...(b.name !== undefined ? { name: b.name } : {}), ...(steps ? { steps } : {}),
        ...(b.is_default !== undefined ? { isDefault: b.is_default } : {}), ...(b.active !== undefined ? { active: b.active } : {}),
        // A plan that is switched off is not the usual one for new leads either.
        ...(b.active === false ? { isDefault: false } : {}), updatedAt: new Date(),
      }).where(eq(followUpPlans.id, id)).returning();
      // Leads part-way through a plan whose steps got fewer would point past its end: they start it again.
      if (steps) await ctx.tx.update(leads).set({ planStep: 0 }).where(sql`${leads.planId} = ${id} and ${leads.planStep} >= ${steps.length}`);
      await audit(ctx, 'follow_up_plan', id, 'update', before, after);
      return after;
    });
    res.json({ data: row });
  });

  r.post('/:id/plan', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ plan_id: zId }).parse(req.body);
    await inTx(db, req, (ctx) => startPlan(ctx, id, b.plan_id));
    res.json({ ok: true });
  });

  r.delete('/:id/plan', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, (ctx) => stopPlan(ctx, id, `stopped by ${ctx.user!.name}`));
    res.json({ ok: true });
  });

  return r;
}
