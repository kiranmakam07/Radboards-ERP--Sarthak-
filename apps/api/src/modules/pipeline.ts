import { and, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  D, LEAD_STAGE_LABELS, OPEN_LEAD_STAGES, PAYMENT_MODES, TEST_RIDE_OUTCOMES, istDate, type LeadStage, type PaymentMode, type TestRideOutcome,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { rows, type DB } from '../db/client';
import { leadActivities, leads, parties, salesOrderLines, testRides, units } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zMoney, zMoneyPos, zText, type Ctx } from '../lib/http';
import { createParty } from './parties';
import { createPayment } from './payments';
import { reserve } from './reservations';
import { confirmOrder, createOrder } from './sales';

/**
 * The sales pipeline for vehicles (P2 of the founder's brief of 21 Oct 2026):
 *
 *   ... meeting_booked -> test_ride_booked -> test_ride_done -> quoted -> booked -> delivered -> converted
 *
 * - A test ride is booked for a lead on a demo unit (a unit whose status is demo), in a slot; the same demo
 *   unit is never booked twice for overlapping times. Booking one moves the lead to test ride booked, and
 *   recording it done moves it to test ride done.
 * - A booking is a confirmed sales order with an advance payment and the vehicle held for it by serial
 *   (a stock reservation naming the unit). It moves the lead to booked; delivering that order (which needs
 *   its delivery checklist done, modules/sales.ts) moves it to delivered.
 */

type Lead = typeof leads.$inferSelect;

async function lockLead(tx: DB, id: string): Promise<Lead> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, id)).for('update');
  must(lead, 'Lead');
  return lead!;
}

/** Move a lead to a stage reached by what happened (a test ride, a booking), with a line in its history. */
async function stageTo(ctx: Ctx, lead: Lead, stage: LeadStage, note: string) {
  if (lead.stage === stage) return;
  await ctx.tx.update(leads).set({ stage, updatedAt: new Date(), firstContactedAt: lead.firstContactedAt ?? new Date() }).where(eq(leads.id, lead.id));
  await ctx.tx.insert(leadActivities).values({
    leadId: lead.id, type: 'stage_change', note: `${LEAD_STAGE_LABELS[lead.stage]} -> ${LEAD_STAGE_LABELS[stage]}: ${note}`, userId: ctx.user?.id ?? null,
  });
  await audit(ctx, 'lead', lead.id, 'stage_change', { stage: lead.stage }, { stage, note });
}

// ---------------------------------------------------------------------------
// Test rides
// ---------------------------------------------------------------------------
export async function bookTestRide(ctx: Ctx, leadId: string, input: { unitId: string; slotAt: string; minutes?: number; staffId?: string | null; notes?: string | null }) {
  const { tx } = ctx;
  const lead = await lockLead(tx, leadId);
  if (!OPEN_LEAD_STAGES.includes(lead.stage) || lead.stage === 'booked') throw conflict(`This lead is ${LEAD_STAGE_LABELS[lead.stage]}: a test ride is for a lead still deciding`);
  // One booking at a time per demo unit, so two people cannot book the same slot at the same moment.
  const [unit] = await tx.select().from(units).where(eq(units.id, input.unitId)).for('update');
  if (!unit) throw badRequest('Unit not found');
  if (unit.status !== 'demo') throw conflict(`${unit.serialNo} is not a demo unit (it is ${unit.status.replace('_', ' ')})`);
  const start = new Date(input.slotAt);
  const minutes = input.minutes ?? 30;
  const end = new Date(start.getTime() + minutes * 60_000);
  const [clash] = await rows<{ slot_at: string }>(tx, sql`
    select slot_at::text from test_rides
     where unit_id = ${unit.id} and outcome = 'booked'
       and slot_at < ${end.toISOString()}::timestamptz and slot_at + make_interval(mins => minutes) > ${start.toISOString()}::timestamptz
     limit 1`);
  if (clash) throw conflict(`${unit.serialNo} is already booked for a test ride then`);
  const [ride] = await tx.insert(testRides).values({
    leadId, unitId: unit.id, slotAt: start, minutes, staffId: input.staffId ?? ctx.user?.id ?? null, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
  }).returning();
  if (['new', 'contacted', 'interested', 'meeting_booked'].includes(lead.stage)) await stageTo(ctx, lead, 'test_ride_booked', `on ${unit.serialNo}`);
  await audit(ctx, 'test_ride', ride!.id, 'create', null, ride);
  return ride!;
}

/** How the test ride went. Done moves a lead waiting for it to test ride done; a no-show or a cancellation leaves the lead where it is. */
export async function setTestRideOutcome(ctx: Ctx, id: string, outcome: Exclude<TestRideOutcome, 'booked'>, notes?: string | null) {
  const { tx } = ctx;
  const [ride] = await tx.select().from(testRides).where(eq(testRides.id, id)).for('update');
  must(ride, 'Test ride');
  if (ride!.outcome !== 'booked') throw conflict(`This test ride is already ${ride!.outcome.replace('_', ' ')}`);
  const [updated] = await tx.update(testRides).set({ outcome, notes: notes ?? ride!.notes, updatedAt: new Date() }).where(eq(testRides.id, id)).returning();
  if (outcome === 'done') {
    const lead = await lockLead(tx, ride!.leadId);
    if (lead.stage === 'test_ride_booked') await stageTo(ctx, lead, 'test_ride_done', notes ?? 'ridden');
  }
  await audit(ctx, 'test_ride', id, 'outcome', { outcome: 'booked' }, { outcome, notes });
  return updated!;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------
export type BookingInput = {
  itemId: string; serial: string; rate?: string | null; locationId?: string | null;
  advance: { mode: PaymentMode; amount: string; accountId?: string | null; reference?: string | null };
};

/**
 * Book a vehicle for a lead: the customer (made from the lead the first time), a confirmed order at the
 * price list rate (or the rate given, under the usual price checks), the vehicle held for it by serial, and
 * the advance received. The lead moves to booked.
 */
export async function bookVehicle(ctx: Ctx, leadId: string, input: BookingInput) {
  const { tx } = ctx;
  const lead = await lockLead(tx, leadId);
  if (!OPEN_LEAD_STAGES.includes(lead.stage) || lead.stage === 'booked') throw conflict(`This lead is ${LEAD_STAGE_LABELS[lead.stage]}: it cannot be booked`);
  if (D(input.advance.amount).lte(0)) throw badRequest('A booking takes an advance');
  let partyId = lead.partyId;
  if (!partyId) {
    const [known] = await tx.select().from(parties).where(and(eq(parties.phone, lead.phone), eq(parties.partyType, 'customer')));
    partyId = known?.id ?? (await createParty(ctx, {
      party_type: 'customer', name: lead.name, phone: lead.phone, email: lead.email, gstin: lead.gstin, state_code: null, billing_address: null,
      shipping_address: null, lead_id: lead.id,
    })).id;
    await tx.update(leads).set({ partyId, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  }
  const order = await createOrder(ctx, {
    channel: 'store', partyId, leadId: lead.id, orderDate: istDate(), notes: `Booking for lead ${lead.leadNo ?? lead.name}`,
    lines: [{ itemId: input.itemId, qty: '1', rate: input.rate ?? null }],
  });
  const confirmed = await confirmOrder(ctx, order.id, { paidNow: D(input.advance.amount) });
  const [line] = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id));
  await reserve(ctx, order.id, { lines: [{ orderLineId: line!.id, qty: '1', locationId: input.locationId ?? null, serials: [input.serial] }] });
  const payment = await createPayment(ctx, {
    direction: 'in', partyId, mode: input.advance.mode, accountId: input.advance.accountId, amount: input.advance.amount,
    reference: input.advance.reference ?? null, paidOn: istDate(), notes: `Advance for ${order.orderNo}`, salesOrderId: order.id,
  });
  await stageTo(ctx, lead, 'booked', `${order.orderNo}, ${input.serial.trim().toUpperCase()}`);
  return { order: confirmed, payment };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function pipelineRouter(db: DB) {
  const r = Router();
  const zInstant = z.string().datetime({ offset: true });

  /** Test rides between two days (today and the week ahead by default), with the lead and the demo unit. */
  r.get('/test-rides', requirePerm('leads:read'), async (req, res) => {
    const q = z.object({ from: zDate.prefault(() => istDate()), to: zDate.optional(), lead_id: zId.optional() }).parse(req.query);
    sendList(req, res, await rows(db, sql`
      select t.id, t.slot_at, t.minutes, t.outcome, t.notes, t.lead_id, l.name as lead_name, l.phone as lead_phone, l.stage as lead_stage,
             u.serial_no, i.name as item_name, s.name as staff_name
        from test_rides t join leads l on l.id = t.lead_id join units u on u.id = t.unit_id join items i on i.id = u.item_id
        left join users s on s.id = t.staff_id
       where (${q.lead_id ?? null}::uuid is not null and t.lead_id = ${q.lead_id ?? null}::uuid)
          or (${q.lead_id ?? null}::uuid is null and (t.slot_at at time zone 'Asia/Kolkata')::date >= ${q.from}::date
              and (${q.to ?? null}::date is null or (t.slot_at at time zone 'Asia/Kolkata')::date <= ${q.to ?? null}::date))
       order by t.slot_at`), 'test-rides');
  });

  /** The demo units a test ride can be booked on. */
  r.get('/demo-units', requirePerm('leads:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select u.id, u.serial_no, i.name as item_name, l.name as location from units u join items i on i.id = u.item_id
        left join locations l on l.id = u.location_id where u.status = 'demo' order by i.name, u.serial_no`) });
  });

  r.post('/leads/:id/test-rides', requirePerm('leads:write'), async (req, res) => {
    const b = z.object({
      unit_id: zId, slot_at: zInstant, minutes: z.coerce.number().int().min(5).max(480).prefault(30), staff_id: emptyToNull(zId).optional(),
      notes: emptyToNull(z.string().trim().max(500)).optional(),
    }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => bookTestRide(ctx, zId.parse(req.params.id), {
      unitId: b.unit_id, slotAt: b.slot_at, minutes: b.minutes, staffId: b.staff_id, notes: b.notes,
    })) });
  });

  r.post('/test-rides/:id/outcome', requirePerm('leads:write'), async (req, res) => {
    const b = z.object({ outcome: z.enum(TEST_RIDE_OUTCOMES).exclude(['booked']), notes: emptyToNull(z.string().trim().max(500)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => setTestRideOutcome(ctx, zId.parse(req.params.id), b.outcome, b.notes)) });
  });

  r.post('/leads/:id/booking', requirePerm('sales:write'), async (req, res) => {
    const b = z.object({
      item_id: zId, serial: zText(60), rate: emptyToNull(zMoney).optional(), location_id: emptyToNull(zId).optional(),
      advance: z.object({ mode: z.enum(PAYMENT_MODES), amount: zMoneyPos, account_id: emptyToNull(zId).optional(), reference: emptyToNull(z.string().trim().max(100)).optional() }),
    }).parse(req.body);
    const result = await inTx(db, req, (ctx) => bookVehicle(ctx, zId.parse(req.params.id), {
      itemId: b.item_id, serial: b.serial, rate: b.rate, locationId: b.location_id,
      advance: { mode: b.advance.mode, amount: b.advance.amount, accountId: b.advance.account_id, reference: b.advance.reference },
    }));
    res.status(201).json({ data: result });
  });

  return r;
}
