import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  FOLLOW_UP_REQUIRED_STAGES, LEAD_STAGES, LEAD_STAGE_LABELS, canMoveLead, istDate, type LeadStage,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { nextNumber } from '../core/numbering';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { campaigns, items, leadActivities, leadSources, leads, lostReasons, parties, users } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import {
  emptyToNull, inTx, sendList, zAddress, zDate, zGstin, zId, zListQuery, zPhone, zStateCode, zText, type Ctx,
} from '../lib/http';
import { createParty, type Party } from './parties';

export type Lead = typeof leads.$inferSelect;

const zWhen = z.coerce.date();

export type CaptureInput = {
  name: string;
  phone: string; // already normalised
  email?: string | null;
  sourceId: string;
  sourceDetail?: string | null;
  campaignId?: string | null;
  externalRef?: string | null;
  interestedItemIds?: string[];
  notes?: string | null;
  ownerId?: string | null;
  nextFollowUpAt?: Date | null;
  attendedBy?: string | null;
  address?: unknown;
  gstin?: string | null;
};

async function pickOwner(ctx: Ctx, sourceDefaultOwner: string | null, explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  if (sourceDefaultOwner) return sourceDefaultOwner; // source rule
  if (ctx.user && (ctx.user.role === 'sales' || ctx.user.role === 'store')) return ctx.user.id; // whoever took the enquiry
  // Round-robin across active salespeople. The settings row is locked so two leads
  // arriving together still alternate.
  await ctx.tx.execute(sql`select 1 from settings where key = 'lead_round_robin_last' for update`);
  const team = await ctx.tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'sales'), eq(users.active, true)))
    .orderBy(asc(users.createdAt), asc(users.id));
  if (team.length === 0) return ctx.user?.id ?? null;
  const last = await getSetting(ctx.tx, 'lead_round_robin_last');
  const idx = team.findIndex((u) => u.id === last);
  const next = team[(idx + 1) % team.length]!;
  await setSetting(ctx.tx, 'lead_round_robin_last', next.id, ctx.user?.id ?? null);
  return next.id;
}

/**
 * Every enquiry, from any source, lands here (PRD 7.1).
 * - same external_ref (webhook retry)  -> returns the lead already created
 * - same phone as an existing lead     -> logs an "enquiry" activity on it, no duplicate
 * - otherwise                          -> new lead with an owner and a first follow-up date
 */
export async function captureLead(ctx: Ctx, input: CaptureInput): Promise<{ lead: Lead; duplicate: boolean }> {
  const { tx } = ctx;
  // One capture per phone number at a time. Without this, a double-tap on the tablet or a
  // webhook retry arriving with the original both see "no lead yet" and both insert one.
  // The lock is released when this transaction ends, so the second caller then finds the first's lead.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.phone}, 0))`);
  if (input.externalRef) {
    const [same] = await tx.select().from(leads).where(eq(leads.externalRef, input.externalRef));
    if (same) return { lead: same, duplicate: true };
  }
  const [source] = await tx.select().from(leadSources).where(eq(leadSources.id, input.sourceId));
  if (!source) throw badRequest('Unknown lead source');

  const [existing] = await tx
    .select()
    .from(leads)
    .where(eq(leads.phone, input.phone))
    .orderBy(sql`case when ${leads.stage} in ('new','contacted','interested','meeting_booked') then 0 else 1 end`, desc(leads.createdAt))
    .limit(1)
    .for('update');

  const detail = [source.name, input.sourceDetail].filter(Boolean).join(' / ');
  if (existing) {
    await tx.insert(leadActivities).values({
      leadId: existing.id,
      type: 'enquiry',
      note: `Repeat enquiry via ${detail}${input.notes ? `: ${input.notes}` : ''}`,
      userId: ctx.user?.id ?? null,
    });
    const merged = [...new Set([...existing.interestedItemIds, ...(input.interestedItemIds ?? [])])];
    const patch: Partial<typeof leads.$inferInsert> = { interestedItemIds: merged, updatedAt: new Date() };
    // "It can be reopened to Contacted if the person comes back" (PRD 6.1).
    if (existing.stage === 'lost') {
      patch.stage = 'contacted';
      patch.lostReasonId = null;
      patch.nextFollowUpAt = input.nextFollowUpAt ?? new Date();
      await tx.insert(leadActivities).values({
        leadId: existing.id, type: 'stage_change', note: 'Lost -> Contacted (came back with a new enquiry)', userId: ctx.user?.id ?? null,
      });
    }
    const [updated] = await tx.update(leads).set(patch).where(eq(leads.id, existing.id)).returning();
    await audit(ctx, 'lead', existing.id, 'repeat_enquiry', { stage: existing.stage }, { stage: updated!.stage, via: detail });
    return { lead: updated!, duplicate: true };
  }

  if (input.interestedItemIds?.length) {
    const found = await tx.select({ id: items.id }).from(items).where(inArray(items.id, input.interestedItemIds));
    if (found.length !== new Set(input.interestedItemIds).size) throw badRequest('One of the products does not exist');
  }
  const followDays = await getSetting(tx, 'default_follow_up_days');
  const ownerId = await pickOwner(ctx, source.defaultOwnerId, input.ownerId);
  const { number } = await nextNumber(tx, 'lead', istDate());
  const [lead] = await tx
    .insert(leads)
    .values({
      leadNo: number,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      sourceId: input.sourceId,
      sourceDetail: input.sourceDetail ?? null,
      campaignId: input.campaignId ?? null,
      externalRef: input.externalRef ?? null,
      interestedItemIds: [...new Set(input.interestedItemIds ?? [])],
      ownerId,
      nextFollowUpAt: input.nextFollowUpAt ?? new Date(Date.now() + followDays * 86400_000),
      attendedBy: input.attendedBy ?? null,
      address: (input.address as object) ?? null,
      gstin: input.gstin ?? null,
      notes: input.notes ?? null,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await tx.insert(leadActivities).values({
    leadId: lead!.id, type: 'enquiry', note: `Captured via ${detail}`, userId: ctx.user?.id ?? null,
  });
  await audit(ctx, 'lead', lead!.id, 'create', null, lead);
  return { lead: lead!, duplicate: false };
}

export async function moveLead(
  ctx: Ctx,
  id: string,
  input: { stage: LeadStage; lostReasonId?: string | null; nextFollowUpAt?: Date | null; note?: string | null },
): Promise<Lead> {
  const { tx } = ctx;
  const [lead] = await tx.select().from(leads).where(eq(leads.id, id)).for('update');
  must(lead, 'Lead');
  const from = lead!.stage;
  if (input.stage === 'converted') throw badRequest('Use Convert to turn a lead into a party');
  if (from === input.stage) throw badRequest(`Lead is already ${LEAD_STAGE_LABELS[from]}`);
  if (!canMoveLead(from, input.stage)) {
    throw conflict(`A lead cannot move from ${LEAD_STAGE_LABELS[from]} to ${LEAD_STAGE_LABELS[input.stage]}`);
  }
  const patch: Partial<typeof leads.$inferInsert> = { stage: input.stage, updatedAt: new Date() };
  if (input.stage === 'lost') {
    if (!input.lostReasonId) throw badRequest('Pick a lost reason');
    const [reason] = await tx.select().from(lostReasons).where(eq(lostReasons.id, input.lostReasonId));
    if (!reason || !reason.active) throw badRequest('Unknown lost reason');
    patch.lostReasonId = reason.id;
    patch.nextFollowUpAt = null;
  } else {
    patch.lostReasonId = null;
    const followUp = input.nextFollowUpAt ?? lead!.nextFollowUpAt;
    if (FOLLOW_UP_REQUIRED_STAGES.includes(input.stage) && !followUp) throw badRequest('Set the next follow-up date');
    patch.nextFollowUpAt = followUp;
    if (!lead!.firstContactedAt) patch.firstContactedAt = new Date();
  }
  const [updated] = await tx.update(leads).set(patch).where(eq(leads.id, id)).returning();
  await tx.insert(leadActivities).values({
    leadId: id,
    type: 'stage_change',
    note: `${LEAD_STAGE_LABELS[from]} -> ${LEAD_STAGE_LABELS[input.stage]}${input.note ? `: ${input.note}` : ''}`,
    userId: ctx.user?.id ?? null,
  });
  await audit(ctx, 'lead', id, 'stage_change', { stage: from }, { stage: input.stage, lostReasonId: patch.lostReasonId ?? null });
  return updated!;
}

/**
 * Convert (PRD 7.4): creates the party from the lead (or links the party that already has
 * this phone), links both ways and sets the lead to Converted. One click, nothing retyped.
 */
export async function convertLead(
  ctx: Ctx,
  id: string,
  input: {
    partyType: 'customer' | 'dealer'; name?: string; gstin?: string | null; stateCode?: string | null;
    billingAddress?: z.infer<typeof zAddress> | null; email?: string | null;
  },
): Promise<{ lead: Lead; party: Party }> {
  const { tx } = ctx;
  const [lead] = await tx.select().from(leads).where(eq(leads.id, id)).for('update');
  must(lead, 'Lead');
  if (lead!.stage === 'converted') {
    const [party] = await tx.select().from(parties).where(eq(parties.id, lead!.partyId!));
    return { lead: lead!, party: party! };
  }
  if (!canMoveLead(lead!.stage, 'converted')) throw conflict('Reopen this lost lead before converting it');

  let [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.phone, lead!.phone), eq(parties.partyType, input.partyType)));
  if (!party) {
    party = await createParty(ctx, {
      party_type: input.partyType,
      name: input.name ?? lead!.name,
      phone: lead!.phone,
      email: input.email ?? lead!.email,
      gstin: input.gstin ?? lead!.gstin,
      state_code: input.stateCode ?? null,
      billing_address: input.billingAddress ?? (lead!.address as z.infer<typeof zAddress> | null) ?? null,
      shipping_address: null,
      lead_id: lead!.id,
    });
  }
  const [updated] = await tx
    .update(leads)
    .set({
      stage: 'converted', partyId: party.id, convertedAt: new Date(), nextFollowUpAt: null, lostReasonId: null,
      firstContactedAt: lead!.firstContactedAt ?? new Date(), updatedAt: new Date(),
    })
    .where(eq(leads.id, id))
    .returning();
  await tx.insert(leadActivities).values({
    leadId: id, type: 'stage_change', note: `${LEAD_STAGE_LABELS[lead!.stage]} -> Converted (${input.partyType}: ${party.name})`,
    userId: ctx.user?.id ?? null,
  });
  await audit(ctx, 'lead', id, 'convert', { stage: lead!.stage }, { stage: 'converted', partyId: party.id });
  return { lead: updated!, party };
}

export async function sourceIdByName(tx: DB, name: string): Promise<string> {
  const [s] = await tx.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.name, name));
  if (!s) throw badRequest(`Lead source "${name}" is missing`);
  return s.id;
}

/** Saved views (PRD 7.3) as SQL filters - "saved filters, not questions". */
const VIEWS: Record<string, ReturnType<typeof sql>> = {
  followups_due: sql`l.stage in ('new','contacted','interested','meeting_booked') and l.next_follow_up_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'`,
  overdue: sql`l.stage in ('new','contacted','interested','meeting_booked') and l.next_follow_up_at < now()`,
  interested_not_bought: sql`l.stage in ('interested','meeting_booked')`,
  open: sql`l.stage in ('new','contacted','interested','meeting_booked')`,
  converted: sql`l.stage = 'converted'`,
  lost: sql`l.stage = 'lost'`,
};

export function leadsRouter(db: DB) {
  const r = Router();

  r.get('/', requirePerm('leads:read'), async (req, res) => {
    const q = zListQuery.extend({
      stage: z.enum(LEAD_STAGES).optional(),
      owner_id: zId.optional(),
      source_id: zId.optional(),
      view: z.enum(['followups_due', 'overdue', 'interested_not_bought', 'open', 'converted', 'lost']).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      mine: z.enum(['true', 'false']).optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const digits = q.q ? q.q.replace(/\D/g, '') : '';
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    const owner = q.mine === 'true' ? req.user!.id : (q.owner_id ?? null);
    const data = await rows(db, sql`
      select l.*, s.name as source_name, o.name as owner_name, lr.name as lost_reason,
             (l.stage in ('new','contacted','interested','meeting_booked') and l.next_follow_up_at < now()) as overdue,
             (select coalesce(array_agg(i.name order by i.name), '{}') from items i where i.id = any(l.interested_item_ids)) as interested_items
        from leads l
        join lead_sources s on s.id = l.source_id
        left join users o on o.id = l.owner_id
        left join lost_reasons lr on lr.id = l.lost_reason_id
       where (${q.stage ?? null}::text is null or l.stage::text = ${q.stage ?? null})
         and (${owner}::uuid is null or l.owner_id = ${owner}::uuid)
         and (${q.source_id ?? null}::uuid is null or l.source_id = ${q.source_id ?? null}::uuid)
         and (${q.from ?? null}::date is null or (l.created_at at time zone 'Asia/Kolkata')::date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or (l.created_at at time zone 'Asia/Kolkata')::date <= ${q.to ?? null}::date)
         and (${like}::text is null or l.name ilike ${like} or l.lead_no ilike ${like}
              or (${phoneLike}::text is not null and l.phone like ${phoneLike}))
         and (${q.view ? VIEWS[q.view]! : sql`true`})
       order by ${q.view === 'followups_due' || q.view === 'overdue' ? sql`l.next_follow_up_at asc` : sql`l.created_at desc`}
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'leads');
  });

  /**
   * Repeat-customer lookup as the phone is typed (PRD 7.2): existing leads and parties,
   * with past purchases, so name/address auto-fill and nobody is entered twice.
   */
  r.get('/lookup', requirePerm('leads:read', 'parties:read'), async (req, res) => {
    const phone = zPhone.parse(req.query.phone);
    const foundLeads = await rows(db, sql`
      select l.id, l.lead_no, l.name, l.phone, l.stage, l.party_id, l.address, l.next_follow_up_at, s.name as source_name
        from leads l join lead_sources s on s.id = l.source_id where l.phone = ${phone} order by l.created_at desc`);
    const foundParties = await rows<{ id: string }>(db, sql`
      select p.id, p.name, p.phone, p.party_type, p.gstin, p.state_code, p.billing_address,
             coalesce(b.balance, 0) as balance
        from parties p left join v_party_balances b on b.party_id = p.id
       where p.phone = ${phone} and p.party_type in ('customer','dealer') and p.active`);
    const ids = foundParties.map((p) => p.id);
    const purchases = ids.length
      ? await rows(db, sql`
          select i.id, i.invoice_no, i.invoice_date, i.grand_total, i.party_id,
                 (select string_agg(il.description || ' x ' || trim(to_char(il.qty, 'FM999999990.###'), '.'), ', ')
                    from invoice_lines il where il.invoice_id = i.id) as items
            from invoices i
           where i.party_id in ${ids} and i.doc_type = 'tax_invoice' and i.status = 'issued'
           order by i.invoice_date desc limit 20`)
      : [];
    res.json({ data: { phone, leads: foundLeads, parties: foundParties, purchases } });
  });

  /** Kanban board: open stages, newest follow-up first. */
  r.get('/pipeline', requirePerm('leads:read'), async (req, res) => {
    const q = z.object({ owner_id: zId.optional(), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
    const owner = q.mine === 'true' ? req.user!.id : (q.owner_id ?? null);
    const data = await rows(db, sql`
      select l.id, l.lead_no, l.name, l.phone, l.stage, l.next_follow_up_at, l.owner_id, o.name as owner_name,
             s.name as source_name,
             (l.next_follow_up_at < now()) as overdue,
             (select coalesce(sum(i.retail_price), 0) from items i where i.id = any(l.interested_item_ids)) as value
        from leads l join lead_sources s on s.id = l.source_id left join users o on o.id = l.owner_id
       where l.stage in ('new','contacted','interested','meeting_booked')
         and (${owner}::uuid is null or l.owner_id = ${owner}::uuid)
       order by l.next_follow_up_at asc nulls last`);
    res.json({ data, stages: ['new', 'contacted', 'interested', 'meeting_booked'] });
  });

  r.get('/:id', requirePerm('leads:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [lead] = await rows(db, sql`
      select l.*, s.name as source_name, o.name as owner_name, lr.name as lost_reason, a.name as attended_by_name,
             p.name as party_name,
             (select coalesce(json_agg(json_build_object('id', i.id, 'name', i.name, 'sku', i.sku, 'retail_price', i.retail_price)), '[]'::json)
                from items i where i.id = any(l.interested_item_ids)) as interested_items
        from leads l
        join lead_sources s on s.id = l.source_id
        left join users o on o.id = l.owner_id
        left join users a on a.id = l.attended_by
        left join lost_reasons lr on lr.id = l.lost_reason_id
        left join parties p on p.id = l.party_id
       where l.id = ${id}`);
    must(lead, 'Lead');
    const activities = await rows(db, sql`
      select a.id, a.type, a.note, a.at, u.name as user_name
        from lead_activities a left join users u on u.id = a.user_id
       where a.lead_id = ${id} order by a.at desc, a.id`);
    res.json({ data: { ...lead, activities } });
  });

  const zCapture = z.object({
    name: zText(150),
    phone: zPhone,
    email: emptyToNull(z.string().email().max(200)).optional(),
    source_id: zId,
    source_detail: emptyToNull(z.string().trim().max(200)).optional(),
    campaign_id: emptyToNull(zId).optional(),
    interested_item_ids: z.array(zId).max(20).default([]),
    notes: emptyToNull(z.string().trim().max(2000)).optional(),
    owner_id: emptyToNull(zId).optional(),
    next_follow_up_at: emptyToNull(zWhen).optional(),
    address: zAddress.nullish(),
    gstin: emptyToNull(zGstin).optional(),
  });

  /** Manual capture: quick add by any sales or store user (PRD 7.1). */
  r.post('/', requirePerm('leads:write'), async (req, res) => {
    const b = zCapture.parse(req.body);
    const result = await inTx(db, req, (ctx) =>
      captureLead(ctx, {
        name: b.name, phone: b.phone, email: b.email, sourceId: b.source_id, sourceDetail: b.source_detail,
        campaignId: b.campaign_id, interestedItemIds: b.interested_item_ids, notes: b.notes, ownerId: b.owner_id,
        nextFollowUpAt: b.next_follow_up_at, address: b.address, gstin: b.gstin,
      }));
    res.status(result.duplicate ? 200 : 201).json({ data: result.lead, duplicate: result.duplicate });
  });

  /**
   * Walk-in tablet form (PRD 7.2): phone, name, products, notes, outcome.
   * Source, time, attended_by are stamped automatically. "Buying now" converts on the
   * spot (New -> Converted) and returns the party for the quick bill.
   */
  r.post('/walk-in', requirePerm('leads:write'), async (req, res) => {
    const b = z.object({
      phone: zPhone,
      name: zText(150),
      interested_item_ids: z.array(zId).max(20).default([]),
      notes: emptyToNull(z.string().trim().max(2000)).optional(),
      outcome: z.enum(['enquiry', 'buying_now']),
    }).parse(req.body);
    const result = await inTx(db, req, async (ctx) => {
      const sourceId = await sourceIdByName(ctx.tx, 'Walk-in');
      const captured = await captureLead(ctx, {
        name: b.name, phone: b.phone, sourceId, interestedItemIds: b.interested_item_ids, notes: b.notes,
        attendedBy: ctx.user!.id,
      });
      if (b.outcome === 'buying_now') {
        const { lead, party } = await convertLead(ctx, captured.lead.id, { partyType: 'customer', name: b.name });
        return { lead, party, duplicate: captured.duplicate };
      }
      return { lead: captured.lead, party: null, duplicate: captured.duplicate };
    });
    res.status(201).json({ data: result });
  });

  r.patch('/:id', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      name: zText(150),
      email: emptyToNull(z.string().email().max(200)),
      source_detail: emptyToNull(z.string().trim().max(200)),
      interested_item_ids: z.array(zId).max(20),
      notes: emptyToNull(z.string().trim().max(2000)),
      owner_id: zId,
      next_follow_up_at: zWhen,
      address: zAddress.nullable(),
      gstin: emptyToNull(zGstin),
    }).partial().parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(leads).where(eq(leads.id, id)).for('update');
      must(before, 'Lead');
      const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name;
      if (b.email !== undefined) patch.email = b.email;
      if (b.source_detail !== undefined) patch.sourceDetail = b.source_detail;
      if (b.interested_item_ids !== undefined) patch.interestedItemIds = b.interested_item_ids;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.owner_id !== undefined) patch.ownerId = b.owner_id;
      if (b.next_follow_up_at !== undefined) patch.nextFollowUpAt = b.next_follow_up_at;
      if (b.address !== undefined) patch.address = b.address;
      if (b.gstin !== undefined) patch.gstin = b.gstin;
      const [row] = await ctx.tx.update(leads).set(patch).where(eq(leads.id, id)).returning();
      await audit(ctx, 'lead', id, 'update', before, row);
      return row;
    });
    res.json({ data: updated });
  });

  r.post('/:id/stage', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      stage: z.enum(LEAD_STAGES),
      lost_reason_id: emptyToNull(zId).optional(),
      next_follow_up_at: emptyToNull(zWhen).optional(),
      note: emptyToNull(z.string().trim().max(1000)).optional(),
    }).parse(req.body);
    const lead = await inTx(db, req, (ctx) =>
      moveLead(ctx, id, { stage: b.stage, lostReasonId: b.lost_reason_id, nextFollowUpAt: b.next_follow_up_at, note: b.note }));
    res.json({ data: lead });
  });

  /** Activity log: call, WhatsApp, meeting, note. Can set the next follow-up in the same tap. */
  r.post('/:id/activities', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      type: z.enum(['call', 'whatsapp', 'meeting', 'note']),
      note: emptyToNull(z.string().trim().max(2000)).optional(),
      next_follow_up_at: emptyToNull(zWhen).optional(),
    }).parse(req.body);
    const activity = await inTx(db, req, async (ctx) => {
      const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, id)).for('update');
      must(lead, 'Lead');
      const [row] = await ctx.tx.insert(leadActivities)
        .values({ leadId: id, type: b.type, note: b.note ?? null, userId: ctx.user!.id }).returning();
      const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
      // First real contact is what "response time" is measured to (PRD 7.10).
      if (!lead!.firstContactedAt && b.type !== 'note') patch.firstContactedAt = new Date();
      if (b.next_follow_up_at) patch.nextFollowUpAt = b.next_follow_up_at;
      await ctx.tx.update(leads).set(patch).where(eq(leads.id, id));
      return row;
    });
    res.status(201).json({ data: activity });
  });

  r.post('/:id/convert', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      party_type: z.enum(['customer', 'dealer']).default('customer'),
      name: zText(200).optional(),
      email: emptyToNull(z.string().email()).optional(),
      gstin: emptyToNull(zGstin).optional(),
      state_code: emptyToNull(zStateCode).optional(),
      billing_address: zAddress.nullish(),
    }).parse(req.body ?? {});
    const result = await inTx(db, req, (ctx) =>
      convertLead(ctx, id, {
        partyType: b.party_type, name: b.name, email: b.email, gstin: b.gstin, stateCode: b.state_code,
        billingAddress: b.billing_address,
      }));
    res.json({ data: result });
  });
  return r;
}

/**
 * Public enquiry endpoint for the website form and campaign QR codes / short links
 * (PRD 7.1). No login: the campaign token identifies the source, and the route is
 * rate-limited in app.ts. Returns the same response for new and repeat enquiries so it
 * cannot be used to probe which phone numbers are already customers.
 */
export function publicLeadsRouter(db: DB) {
  const r = Router();

  r.get('/campaign/:token', async (req, res) => {
    const [c] = await db.select({ name: campaigns.name, active: campaigns.active })
      .from(campaigns).where(eq(campaigns.token, String(req.params.token)));
    if (!c || !c.active) throw must(null, 'Campaign');
    const products = await rows(db, sql`
      select id, name from items where active and item_type = 'finished_good' order by name limit 200`);
    res.json({ data: { campaign: c.name, products } });
  });

  r.post('/enquiry/:token', async (req, res) => {
    const b = z.object({
      name: zText(150),
      phone: zPhone,
      email: emptyToNull(z.string().email().max(200)).optional(),
      interested_item_ids: z.array(zId).max(10).default([]),
      message: emptyToNull(z.string().trim().max(1000)).optional(),
      // Honeypot: real people never fill this hidden field, bots do.
      website: z.string().max(0).optional(),
    }).parse(req.body);
    const [c] = await db.select().from(campaigns).where(eq(campaigns.token, String(req.params.token)));
    if (!c || !c.active) throw must(null, 'Campaign');
    await db.transaction(async (tx) => {
      await captureLead({ tx: tx as unknown as DB, user: null }, {
        name: b.name, phone: b.phone, email: b.email, sourceId: c.sourceId, sourceDetail: c.name, campaignId: c.id,
        interestedItemIds: b.interested_item_ids, notes: b.message,
      });
    });
    res.status(201).json({ ok: true });
  });
  return r;
}
