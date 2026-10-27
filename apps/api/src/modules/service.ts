import crypto from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  CLAIM_STATUSES, CLAIM_TRANSITIONS, D, JOB_CARD_STATUSES, JOB_LINE_KINDS, addMonths, can, canMoveJobCard, computeLine, computeTotals,
  formatDate, isInterState, istDate, money, qty as fmtQty, type ClaimStatus, type JobCardStatus,
} from '@radcore/shared';
import { config } from '../config';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { getCompany } from '../core/settings';
import { lockItems, stockOut } from '../core/stock';
import { taxRateOn } from '../core/taxrates';
import { cleanSerials, genealogy, needsSerials, setUnitStatus, unitEvent, unitsOut } from '../core/units';
import { rows, type DB } from '../db/client';
import {
  faultCodes, items, jobCardFaults, jobCardLines, jobCardMedia, jobCards, locations, parties, salesOrderLines, supplierClaims, units,
  warrantyRules,
} from '../db/schema';
import { badRequest, conflict, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zListQuery, zMoney, zQty, zSerials, zText, type Ctx } from '../lib/http';
import { priceFor, priceListFor } from './items';
import { confirmOrder, createOrder, deliverOrder, invoiceOrder } from './sales';

/**
 * Service and warranty (P2 of the founder's brief of 21 Oct 2026): a job card for each unit brought in.
 *
 *   open -> diagnosed -> estimate_sent -> approved -> in_progress -> ready -> delivered      or cancelled
 *
 * - Warranty is checked by itself: from the day the unit was sold (units.sold_on) against the rule for its
 *   item, and the same for each component fitted inside it. A line is under warranty when the unit, or
 *   (for a part) the component of that item inside it, is covered; only the service manager can change that.
 * - The job card shows what the customer pays and what the warranty covers separately.
 * - The unit is under repair while it is in the workshop. Parts leave the workshop shelf (a service bay)
 *   with stockOut when they are fitted: Dr Warranty Expense for warranty parts, Dr Cost of Goods Sold for
 *   chargeable ones, Cr Stock. A part kept by serial is fitted into the unit by serial.
 * - The customer approves the estimate from a link (/e/<token>), or the workshop records their approval.
 * - Delivering the unit bills the chargeable lines through the usual sales path: an order on the service
 *   channel, delivered without moving stock again (the parts left when fitted), and invoiced by invoiceOrder.
 * - A claim on the supplier of a failed unit goes draft -> sent -> accepted or rejected -> credited; the
 *   credit lowers what we owe the supplier and the warranty expense with it.
 */

export type JobCard = typeof jobCards.$inferSelect;
type JobLine = typeof jobCardLines.$inferSelect;

const OPEN: JobCardStatus[] = ['open', 'diagnosed', 'estimate_sent', 'approved', 'in_progress', 'ready'];
/** Lines can be added or taken off until the work is approved; after that, "more work found" goes back to diagnosed. */
const EDITABLE: JobCardStatus[] = ['open', 'diagnosed', 'estimate_sent'];

// ---------------------------------------------------------------------------
// Warranty
// ---------------------------------------------------------------------------
export type WarrantyAnswer = {
  unit_id: string; serial_no: string; item_id: string; item_name: string; depth: number;
  sold_on: string | null; until: string | null; valid: boolean; reason: string;
};

/**
 * The warranty of a unit and of every component fitted inside it, on a day: each from the day it was
 * sold, against its own item's rule; km and charge-cycle limits against the readings on the job card.
 */
export async function warrantyFor(tx: DB, unitId: string, asOf: string, reading: { km?: number | null; cycles?: number | null } = {}): Promise<WarrantyAnswer[]> {
  const list = await rows<{
    id: string; serial_no: string; item_id: string; item_name: string; depth: number; sold_on: string | null;
    months: number | null; km_limit: number | null; cycle_limit: number | null;
  }>(tx, sql`
    with recursive tree as (
      select u.id, 0 as depth from units u where u.id = ${unitId}
      union all
      select c.id, tree.depth + 1 from units c join tree on c.parent_unit_id = tree.id where tree.depth < 20
    )
    select u.id, u.serial_no, u.item_id, i.name as item_name, tree.depth, u.sold_on::text, w.months, w.km_limit, w.cycle_limit
      from tree join units u on u.id = tree.id join items i on i.id = u.item_id
      left join warranty_rules w on w.item_id = u.item_id and w.active
     order by tree.depth, i.name, u.serial_no`);
  return list.map((u) => {
    const base = { unit_id: u.id, serial_no: u.serial_no, item_id: u.item_id, item_name: u.item_name, depth: u.depth, sold_on: u.sold_on };
    if (!u.sold_on) return { ...base, until: null, valid: false, reason: 'Not sold to a customer' };
    if (!u.months) return { ...base, until: null, valid: false, reason: 'No warranty rule for this item' };
    const until = addMonths(u.sold_on, u.months);
    if (asOf > until) return { ...base, until, valid: false, reason: `Ended on ${formatDate(until)}` };
    if (u.km_limit && reading.km != null && reading.km > u.km_limit) return { ...base, until, valid: false, reason: `Over ${u.km_limit} km` };
    if (u.cycle_limit && reading.cycles != null && reading.cycles > u.cycle_limit) return { ...base, until, valid: false, reason: `Over ${u.cycle_limit} charge cycles` };
    return { ...base, until, valid: true, reason: `Until ${formatDate(until)}` };
  });
}

/** Whether a line is covered: the unit is, or (for a part) a component of the same item inside it is. Labour follows any covered part of the unit. */
function covered(warranty: WarrantyAnswer[], kind: 'part' | 'labour', itemId: string): boolean {
  const [top, ...inside] = warranty;
  if (top?.valid) return true;
  return kind === 'part' ? inside.some((w) => w.item_id === itemId && w.valid) : inside.some((w) => w.valid);
}

const jobWarranty = (tx: DB, job: JobCard) => warrantyFor(tx, job.unitId, istDate(job.createdAt), { km: job.odometerKm, cycles: job.batteryCycles });

// ---------------------------------------------------------------------------
// Totals: chargeable and free, kept apart
// ---------------------------------------------------------------------------
type Priced = Pick<JobLine, 'qty' | 'rate' | 'gstRate' | 'isWarranty'>;

export async function jobTotals(tx: DB, job: JobCard, lines: Priced[]) {
  const company = await getCompany(tx, job.entityId);
  const [party] = await tx.select({ stateCode: parties.stateCode }).from(parties).where(eq(parties.id, job.partyId));
  const inter = isInterState(company.state_code, party?.stateCode ?? company.state_code);
  const computed = lines.map((l) => computeLine({ qty: l.qty, rate: l.rate, discount: 0, gstRate: l.gstRate }, inter, job.taxInclusive));
  return {
    computed,
    chargeable: computeTotals(computed.filter((_, i) => !lines[i]!.isWarranty)),
    free: computeTotals(computed.filter((_, i) => lines[i]!.isWarranty), false),
  };
}

const totalsOut = (t: ReturnType<typeof computeTotals>) => ({
  taxable_total: money(t.taxableTotal), cgst_total: money(t.cgstTotal), sgst_total: money(t.sgstTotal), igst_total: money(t.igstTotal),
  round_off: money(t.roundOff), grand_total: money(t.grandTotal),
});

// ---------------------------------------------------------------------------
// Taking a unit in
// ---------------------------------------------------------------------------
async function lockJob(tx: DB, id: string): Promise<JobCard> {
  const [job] = await tx.select().from(jobCards).where(eq(jobCards.id, id)).for('update');
  must(job, 'Job card');
  return job!;
}

async function unitBySerial(tx: DB, serial: string, itemId?: string | null) {
  // Locked, so two people taking the same unit in at once cannot open two job cards on it.
  const found = await tx.select().from(units).where(and(eq(units.serialNo, serial.trim().toUpperCase()), itemId ? eq(units.itemId, itemId) : undefined)).for('update');
  if (found.length === 0) throw badRequest(`There is no unit with serial ${serial}`);
  if (found.length > 1) throw badRequest(`More than one item has a unit with serial ${serial}: pick the item`);
  return found[0]!;
}

export type JobInput = {
  serial: string; itemId?: string | null; partyId?: string | null; complaint: string; odometerKm?: number | null; batteryCycles?: number | null;
  promisedAt?: string | null; technicianId?: string | null; locationId?: string | null;
};

/** Take a unit in. The customer is the one it was sold to unless another is named; the unit is under repair until it goes back. */
export async function createJobCard(ctx: Ctx, input: JobInput): Promise<JobCard> {
  const { tx } = ctx;
  const unit = await unitBySerial(tx, input.serial, input.itemId);
  if (['scrapped', 'rtv'].includes(unit.status)) throw conflict(`${unit.serialNo} is ${unit.status === 'rtv' ? 'back with its supplier' : 'scrapped'}`);
  const [busy] = await tx.select({ jobNo: jobCards.jobNo }).from(jobCards).where(and(eq(jobCards.unitId, unit.id), inArray(jobCards.status, OPEN)));
  if (busy) throw conflict(`${unit.serialNo} is already in the workshop on ${busy.jobNo}`);
  let partyId = input.partyId ?? null;
  if (!partyId) {
    const [sold] = await rows<{ party_id: string | null }>(tx, sql`
      select i.party_id from invoice_lines l join invoices i on i.id = l.invoice_id where l.id = ${unit.soldInvoiceLineId}`);
    partyId = sold?.party_id ?? null;
  }
  if (!partyId) throw badRequest('Pick the customer: this unit was not sold to a named customer');
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party || party.partyType === 'supplier') throw badRequest('A job card is for a customer, dealer or franchisee');
  let locationId = input.locationId ?? null;
  if (!locationId) {
    const [bay] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.type, 'service_bay'), eq(locations.active, true))).orderBy(asc(locations.createdAt)).limit(1);
    locationId = bay?.id ?? null;
  }
  const [bay] = locationId ? await tx.select().from(locations).where(eq(locations.id, locationId)) : [];
  if (bay?.type !== 'service_bay' || !bay.active) throw badRequest('Parts are taken from a workshop place (a service bay): set one up under Setup > Places');

  const priceList = await priceListFor(tx, party);
  const { number } = await nextNumber(tx, 'job_card', istDate());
  const [job] = await tx.insert(jobCards).values({
    jobNo: number, unitId: unit.id, partyId, locationId: bay.id, complaint: input.complaint, odometerKm: input.odometerKm ?? null,
    batteryCycles: input.batteryCycles ?? null, promisedAt: input.promisedAt ? new Date(input.promisedAt) : null,
    technicianId: input.technicianId ?? null, taxInclusive: priceList.taxInclusive, unitStatusBefore: unit.status, createdBy: ctx.user?.id ?? null,
  }).returning();
  await setUnitStatus(ctx, unit.id, 'under_repair', { event: 'taken_in', refType: 'job_card', refId: job!.id, note: `${number}: ${input.complaint}` });
  await audit(ctx, 'job_card', job!.id, 'create', null, job);
  return job!;
}

// ---------------------------------------------------------------------------
// Lines: parts and labour
// ---------------------------------------------------------------------------
/** An estimate already sent is out of date once its lines change: it goes back to diagnosed, to be sent again. */
async function estimateChanged(ctx: Ctx, job: JobCard) {
  if (job.status !== 'estimate_sent') return;
  await ctx.tx.update(jobCards).set({ status: 'diagnosed', updatedAt: new Date() }).where(eq(jobCards.id, job.id));
  await audit(ctx, 'job_card', job.id, 'status_change', { status: job.status }, { status: 'diagnosed', why: 'estimate changed' });
}

const isApprover = (ctx: Ctx) => Boolean(ctx.user && can(ctx.user.role, 'service:approve'));

/**
 * Add a part or labour at the rate on the customer's price list (or the rate given; the usual price checks
 * apply when it is billed). Whether it is under warranty is worked out; only the service manager can change it.
 */
export async function addJobLine(ctx: Ctx, jobId: string, input: { kind: 'part' | 'labour'; itemId: string; qty: string; rate?: string | null; isWarranty?: boolean | null }) {
  const { tx } = ctx;
  const job = await lockJob(tx, jobId);
  if (!EDITABLE.includes(job.status)) throw conflict(`${job.jobNo} is ${job.status.replace('_', ' ')}: to add work, move it back to diagnosed`);
  const [item] = await tx.select().from(items).where(eq(items.id, input.itemId));
  if (!item || !item.active) throw badRequest('Item not found');
  if (input.kind === 'part' && !item.isStockItem) throw badRequest(`${item.name} is a service: add it as labour`);
  if (input.kind === 'labour' && item.isStockItem) throw badRequest(`${item.name} is a stock item: add it as a part`);
  if (needsSerials(item) && !D(input.qty).isInteger()) throw badRequest(`${item.name} is fitted by serial, in whole units`);
  const [party] = await tx.select().from(parties).where(eq(parties.id, job.partyId));
  const rate = input.rate ?? (await priceFor(tx, item, await priceListFor(tx, party ?? null)));
  const auto = covered(await jobWarranty(tx, job), input.kind, item.id);
  const isWarranty = input.isWarranty ?? auto;
  if (isWarranty !== auto) {
    if (!isApprover(ctx)) throw forbidden(`${item.name} is ${auto ? '' : 'not '}under warranty on this unit: only the service manager can change that`);
    await audit(ctx, 'job_card', job.id, 'warranty_changed', { is_warranty: auto }, { is_warranty: isWarranty, item: item.name });
  }
  const { gstRate } = await taxRateOn(tx, item, istDate());
  const [{ n }] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from job_card_lines where job_card_id = ${job.id}`) as [{ n: number }];
  const [line] = await tx.insert(jobCardLines).values({
    jobCardId: job.id, kind: input.kind, itemId: item.id, qty: fmtQty(input.qty), rate: money(rate), gstRate, isWarranty, sort: n, createdBy: ctx.user?.id ?? null,
  }).returning();
  await estimateChanged(ctx, job);
  await audit(ctx, 'job_card', job.id, 'add_line', null, line);
  return line!;
}

export async function removeJobLine(ctx: Ctx, jobId: string, lineId: string) {
  const { tx } = ctx;
  const job = await lockJob(tx, jobId);
  if (!EDITABLE.includes(job.status)) throw conflict(`${job.jobNo} is ${job.status.replace('_', ' ')}: its lines cannot change`);
  const [line] = await tx.select().from(jobCardLines).where(and(eq(jobCardLines.id, lineId), eq(jobCardLines.jobCardId, jobId)));
  must(line, 'Job line');
  await tx.delete(jobCardLines).where(eq(jobCardLines.id, lineId));
  await estimateChanged(ctx, job);
  await audit(ctx, 'job_card', job.id, 'remove_line', line, null);
}

// ---------------------------------------------------------------------------
// Parts onto the unit
// ---------------------------------------------------------------------------
/** Fit parts from the workshop shelf: stockOut from the service bay, Dr Warranty Expense or Cost of Goods Sold, Cr Stock. */
export async function issuePart(ctx: Ctx, jobId: string, lineId: string, input: { qty: string; serials?: string[] | null }) {
  const { tx } = ctx;
  let job = await lockJob(tx, jobId);
  if (job.status === 'approved') {
    [job] = await tx.update(jobCards).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(jobCards.id, jobId)).returning() as [JobCard];
    await audit(ctx, 'job_card', jobId, 'status_change', { status: 'approved' }, { status: 'in_progress' });
  }
  if (job.status !== 'in_progress') throw conflict(`Parts are fitted once the work is approved (${job.jobNo} is ${job.status.replace('_', ' ')})`);
  const [line] = await tx.select().from(jobCardLines).where(and(eq(jobCardLines.id, lineId), eq(jobCardLines.jobCardId, jobId))).for('update');
  must(line, 'Job line');
  if (line!.kind !== 'part') throw badRequest('Only parts are taken from stock');
  const q = D(input.qty);
  const left = D(line!.qty).minus(line!.issuedQty);
  if (q.gt(left)) throw conflict(`Only ${fmtQty(left)} more of this part is on the job`);
  const [item] = await lockItems(tx, [line!.itemId]);
  const reason = `${job.jobNo}${line!.isWarranty ? ' (warranty)' : ''}`;
  let value;
  let fitted: string[] = [];
  if (needsSerials(item!)) {
    fitted = cleanSerials(item!, q, input.serials);
    // A part on the workshop shelf counts as under repair (core/units.ts), so it may leave from there as well.
    const out = await unitsOut(ctx, {
      item: item!, locationId: job.locationId, serials: fitted, movementType: 'service_issue', refType: 'job_card', refId: job.id,
      event: 'fitted', status: 'sold', soldOn: istDate(), reason, fromStatuses: ['available', 'under_repair'],
    });
    value = out.value;
    await tx.update(units).set({ parentUnitId: job.unitId, updatedAt: new Date() }).where(inArray(units.id, out.units.map((u) => u.id)));
    await unitEvent(ctx, { unitId: job.unitId, event: 'part_fitted', refType: 'job_card', refId: job.id, note: `${item!.name} ${fitted.join(', ')}` });
  } else {
    value = (await stockOut(ctx, {
      itemId: item!.id, locationId: job.locationId, qty: q, movementType: 'service_issue', refType: 'job_card', refId: job.id,
      itemName: item!.name, fallbackCost: item!.purchaseCost, reason,
    })).value;
  }
  await tx.update(jobCardLines).set({
    issuedQty: fmtQty(D(line!.issuedQty).plus(q)), issuedValue: money(D(line!.issuedValue).plus(value)),
    serials: fitted.length ? [...(line!.serials ?? []), ...fitted] : line!.serials, updatedAt: new Date(),
  }).where(eq(jobCardLines.id, lineId));
  await postJournal(ctx, {
    date: istDate(), refType: 'job_card', refId: job.id, entityId: job.entityId,
    narration: `${item!.name} fitted on ${job.jobNo}${line!.isWarranty ? ', under warranty' : ''}`,
    lines: [{ account: line!.isWarranty ? 'warranty_expense' : 'cogs', debit: value }, { account: 'stock', credit: value }],
  });
  await audit(ctx, 'job_card', job.id, 'issue_part', null, { line: lineId, qty: fmtQty(q), serials: fitted, value: money(value) });
  return { value: money(value) };
}

// ---------------------------------------------------------------------------
// Moving the job along
// ---------------------------------------------------------------------------
export const estimateUrl = (token: string) => `${config.webOrigin.split(',')[0]!.trim()}/e/${token}`;

const jobLines = (tx: DB, jobId: string) =>
  tx.select().from(jobCardLines).where(eq(jobCardLines.jobCardId, jobId)).orderBy(asc(jobCardLines.sort), asc(jobCardLines.createdAt));

/** Move a job to its next step, with the check each step needs. Delivery is deliverJob. */
export async function moveJob(ctx: Ctx, jobId: string, to: JobCardStatus, input: { diagnosis?: string | null; reason?: string | null } = {}) {
  const { tx } = ctx;
  const job = await lockJob(tx, jobId);
  if (to === 'delivered') throw badRequest('Deliver the job with its own step: it makes the bill');
  if (!canMoveJobCard(job.status, to)) throw conflict(`${job.jobNo} cannot go from ${job.status.replace('_', ' ')} to ${to.replace('_', ' ')}`);
  const lines = await jobLines(tx, jobId);
  const { chargeable } = await jobTotals(tx, job, lines);
  const patch: Partial<typeof jobCards.$inferInsert> = { status: to, updatedAt: new Date() };
  let url: string | null = null;
  if (to === 'diagnosed') {
    const diagnosis = input.diagnosis?.trim() || job.diagnosis;
    if (!diagnosis) throw badRequest('Write down what is wrong first');
    // Back from approval (more work found): the customer approves the whole job again.
    patch.diagnosis = diagnosis; patch.approvedAt = null; patch.approvedVia = null;
  }
  if (to === 'estimate_sent') {
    if (chargeable.grandTotal.lte(0)) throw badRequest('Nothing on this job is chargeable: approve it as warranty work');
    const token = job.estimateToken ?? crypto.randomBytes(16).toString('base64url');
    patch.estimateToken = token;
    url = estimateUrl(token);
  }
  if (to === 'approved') {
    if (lines.length === 0) throw badRequest('Add the parts and labour first');
    patch.approvedAt = new Date(); patch.approvedVia = chargeable.grandTotal.gt(0) ? 'staff' : 'warranty';
  }
  if (to === 'ready') {
    const short = lines.find((l) => l.kind === 'part' && !D(l.issuedQty).eq(l.qty));
    if (short) throw conflict('Not every part on the job has been fitted yet');
  }
  if (to === 'cancelled') {
    if (!input.reason?.trim()) throw badRequest('Say why the job is cancelled');
    if (lines.some((l) => D(l.issuedQty).gt(0))) throw conflict('Parts have already been fitted, so the job cannot be cancelled: finish it');
    patch.cancelReason = input.reason.trim(); patch.closedAt = new Date();
    await setUnitStatus(ctx, job.unitId, job.unitStatusBefore ?? 'sold', { event: 'given_back', refType: 'job_card', refId: job.id, note: `${job.jobNo} cancelled` });
  }
  const [updated] = await tx.update(jobCards).set(patch).where(eq(jobCards.id, jobId)).returning();
  await audit(ctx, 'job_card', jobId, 'status_change', { status: job.status }, { status: to, ...input });
  return { job: updated!, estimate_url: url };
}

/** The customer approves (or turns down) the estimate from its link. */
export async function answerByLink(ctx: Ctx, token: string, approve: boolean) {
  const { tx } = ctx;
  const [job] = await tx.select().from(jobCards).where(eq(jobCards.estimateToken, token)).for('update');
  if (!job) throw must(null, 'This estimate');
  if (job.status !== 'estimate_sent') throw conflict('This estimate is not waiting for an answer');
  await tx.update(jobCards).set(approve
    ? { status: 'approved', approvedAt: new Date(), approvedVia: 'link', updatedAt: new Date() }
    : { status: 'diagnosed', updatedAt: new Date() }).where(eq(jobCards.id, job.id));
  await audit(ctx, 'job_card', job.id, approve ? 'approved_by_customer' : 'declined_by_customer', null, null);
}

/**
 * Hand the unit back. The chargeable lines are billed through the usual sales path: an order on the service
 * channel, delivered as already issued (the parts left stock when fitted), then invoiced. Warranty lines are not billed.
 */
export async function deliverJob(ctx: Ctx, jobId: string) {
  const { tx } = ctx;
  const job = await lockJob(tx, jobId);
  if (job.status !== 'ready') throw conflict(`${job.jobNo} is ${job.status.replace('_', ' ')}: only a job that is ready can be delivered`);
  const lines = await jobLines(tx, jobId);
  const toBill = lines.filter((l) => !l.isWarranty);
  const today = istDate();
  let invoice: Awaited<ReturnType<typeof invoiceOrder>> | null = null;
  let orderId: string | null = null;
  if (toBill.length) {
    const order = await createOrder(ctx, {
      channel: 'service', partyId: job.partyId, orderDate: today, taxInclusive: job.taxInclusive, entityId: job.entityId, notes: `Job card ${job.jobNo}`,
      lines: toBill.map((l) => ({ itemId: l.itemId, qty: l.kind === 'part' ? l.issuedQty : l.qty, rate: l.rate })),
    });
    await confirmOrder(ctx, order.id);
    const orderLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id)).orderBy(asc(salesOrderLines.sort));
    await deliverOrder(ctx, order.id, {
      locationId: job.locationId, date: today,
      lines: orderLines.map((ol, i) => {
        const jl = toBill[i]!;
        const unitCost = jl.kind === 'part' && D(jl.issuedQty).gt(0) ? money(D(jl.issuedValue).div(jl.issuedQty)) : '0';
        return { orderLineId: ol.id, qty: ol.qty, issuedUnitCost: unitCost };
      }),
    });
    invoice = await invoiceOrder(ctx, order.id, { invoiceDate: today, notes: `Job card ${job.jobNo}` });
    orderId = order.id;
  }
  await setUnitStatus(ctx, job.unitId, job.unitStatusBefore ?? 'sold', { event: 'delivered', refType: 'job_card', refId: job.id, note: job.jobNo });
  const [updated] = await tx.update(jobCards).set({
    status: 'delivered', closedAt: new Date(), salesOrderId: orderId, invoiceId: invoice?.id ?? null, updatedAt: new Date(),
  }).where(eq(jobCards.id, jobId)).returning();
  await audit(ctx, 'job_card', jobId, 'deliver', { status: 'ready' }, { status: 'delivered', invoice: invoice?.invoiceNo ?? null });
  return { job: updated!, invoice };
}

// ---------------------------------------------------------------------------
// Supplier claims
// ---------------------------------------------------------------------------
export async function createClaim(ctx: Ctx, input: { jobCardId: string; unitId: string; supplierId: string; amount?: string | null; notes?: string | null }) {
  const { tx } = ctx;
  const [job] = await tx.select().from(jobCards).where(eq(jobCards.id, input.jobCardId));
  must(job, 'Job card');
  const { descendants } = await genealogy(tx, job!.unitId);
  if (input.unitId !== job!.unitId && !(descendants as { id: string }[]).some((d) => d.id === input.unitId)) throw badRequest('Claim for this job\'s unit or a component inside it');
  const [supplier] = await tx.select().from(parties).where(eq(parties.id, input.supplierId));
  if (supplier?.partyType !== 'supplier') throw badRequest('A claim goes to a supplier');
  const media = await tx.select({ fileId: jobCardMedia.fileId }).from(jobCardMedia).where(eq(jobCardMedia.jobCardId, job!.id));
  const [claim] = await tx.insert(supplierClaims).values({
    jobCardId: job!.id, unitId: input.unitId, supplierId: supplier.id, amount: input.amount ? money(input.amount) : null, notes: input.notes ?? null,
    evidence: media.length ? media.map((m) => m.fileId) : null, createdBy: ctx.user?.id ?? null,
  }).returning();
  await audit(ctx, 'supplier_claim', claim!.id, 'create', null, claim);
  return claim!;
}

/** Credited: the supplier's credit note lowers what we owe them, and the warranty expense by the same amount. */
export async function moveClaim(ctx: Ctx, id: string, to: ClaimStatus, input: { amount?: string | null; creditNoteRef?: string | null }) {
  const { tx } = ctx;
  const [claim] = await tx.select().from(supplierClaims).where(eq(supplierClaims.id, id)).for('update');
  must(claim, 'Claim');
  if (!CLAIM_TRANSITIONS[claim!.status].includes(to)) throw conflict(`This claim cannot go from ${claim!.status} to ${to}`);
  const patch: Partial<typeof supplierClaims.$inferInsert> = { status: to, updatedAt: new Date() };
  if (input.amount) patch.amount = money(input.amount);
  if (to === 'credited') {
    const amount = D(input.amount ?? claim!.amount ?? 0);
    if (amount.lte(0) || !input.creditNoteRef?.trim()) throw badRequest('Give the amount credited and the supplier\'s credit note number');
    patch.amount = money(amount); patch.creditNoteRef = input.creditNoteRef.trim();
    await postJournal(ctx, {
      date: istDate(), refType: 'supplier_claim', refId: id, narration: `Warranty claim credited by the supplier (${input.creditNoteRef.trim()})`,
      lines: [{ account: 'creditors', partyId: claim!.supplierId, debit: amount }, { account: 'warranty_expense', credit: amount }],
    });
  }
  const [updated] = await tx.update(supplierClaims).set(patch).where(eq(supplierClaims.id, id)).returning();
  await audit(ctx, 'supplier_claim', id, 'status_change', { status: claim!.status }, { status: to, ...input });
  return updated!;
}

// ---------------------------------------------------------------------------
// Reading a job
// ---------------------------------------------------------------------------
export async function jobDocument(tx: DB, id: string) {
  const [job] = await tx.select().from(jobCards).where(eq(jobCards.id, id));
  must(job, 'Job card');
  const [head] = await rows(tx, sql`
    select p.name as party_name, p.phone as party_phone, i.name as item_name, u.serial_no, u.item_id, t.name as technician_name,
           l.name as location, o.order_no, v.invoice_no
      from job_cards j join parties p on p.id = j.party_id join units u on u.id = j.unit_id join items i on i.id = u.item_id
      left join users t on t.id = j.technician_id join locations l on l.id = j.location_id
      left join sales_orders o on o.id = j.sales_order_id left join invoices v on v.id = j.invoice_id
     where j.id = ${id}`);
  const lines = await rows<Record<string, any>>(tx, sql`
    select x.*, i.name as item_name, i.sku, i.is_serialised from job_card_lines x join items i on i.id = x.item_id
     where x.job_card_id = ${id} order by x.sort, x.created_at`);
  const { computed, chargeable, free } = await jobTotals(tx, job!, lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gst_rate, isWarranty: l.is_warranty })));
  return {
    ...job!, ...head,
    warranty: await jobWarranty(tx, job!),
    lines: lines.map((l, i) => ({ ...l, line_total: money(computed[i]!.lineTotal) })),
    chargeable: totalsOut(chargeable), free: totalsOut(free),
    faults: await rows(tx, sql`
      select f.id, c.code, c.component, c.description, u.serial_no, f.notes from job_card_faults f join fault_codes c on c.id = f.fault_code_id
        left join units u on u.id = f.unit_id where f.job_card_id = ${id} order by f.created_at`),
    media: await rows(tx, sql`
      select m.id, m.file_id, m.caption, f.original_name from job_card_media m join files f on f.id = m.file_id where m.job_card_id = ${id} order by m.created_at`),
    claims: await rows(tx, sql`
      select c.id, c.status, c.amount, c.credit_note_ref, u.serial_no, i.name as item_name, p.name as supplier_name from supplier_claims c
        join units u on u.id = c.unit_id join items i on i.id = u.item_id join parties p on p.id = c.supplier_id where c.job_card_id = ${id} order by c.created_at`),
    parts_inside: (await genealogy(tx, job!.unitId)).descendants,
    estimate_url: job!.estimateToken ? estimateUrl(job!.estimateToken) : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function serviceRouter(db: DB) {
  const r = Router();
  const zReading = z.coerce.number().int().min(0).max(10_000_000);

  r.get('/jobs', requirePerm('service:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(JOB_CARD_STATUSES).optional(), open: z.enum(['true', 'false']).optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    sendList(req, res, await rows(db, sql`
      select j.id, j.job_no, j.status, j.complaint, j.created_at, j.promised_at, j.closed_at, p.name as party_name, p.phone as party_phone,
             i.name as item_name, u.serial_no, t.name as technician_name
        from job_cards j join parties p on p.id = j.party_id join units u on u.id = j.unit_id join items i on i.id = u.item_id
        left join users t on t.id = j.technician_id
       where (${q.status ?? null}::text is null or j.status::text = ${q.status ?? null})
         and (${q.open ?? null}::text is null or (j.status not in ('delivered', 'cancelled')) = (${q.open ?? null} = 'true'))
         and (${like}::text is null or j.job_no ilike ${like} or u.serial_no ilike ${like} or p.name ilike ${like} or p.phone ilike ${like})
       order by j.created_at desc limit ${q.limit} offset ${q.offset}`), 'job-cards', { limit: q.limit });
  });

  r.get('/technicians', requirePerm('service:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`select id, name, role from users where active and role in ('technician', 'service_manager') order by name`) });
  });

  r.get('/jobs/:id', requirePerm('service:read'), async (req, res) => {
    res.json({ data: await jobDocument(db, zId.parse(req.params.id)) });
  });

  r.post('/jobs', requirePerm('service:write'), async (req, res) => {
    const b = z.object({
      serial: zText(60), item_id: emptyToNull(zId).optional(), party_id: emptyToNull(zId).optional(), complaint: zText(2000),
      odometer_km: emptyToNull(zReading).optional(), battery_cycles: emptyToNull(zReading).optional(),
      promised_at: emptyToNull(z.string().datetime({ offset: true })).optional(), technician_id: emptyToNull(zId).optional(),
      location_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const job = await inTx(db, req, (ctx) => createJobCard(ctx, {
      serial: b.serial, itemId: b.item_id, partyId: b.party_id, complaint: b.complaint, odometerKm: b.odometer_km, batteryCycles: b.battery_cycles,
      promisedAt: b.promised_at, technicianId: b.technician_id, locationId: b.location_id,
    }));
    res.status(201).json({ data: job });
  });

  r.patch('/jobs/:id', requirePerm('service:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      technician_id: emptyToNull(zId).optional(), promised_at: emptyToNull(z.string().datetime({ offset: true })).optional(),
      diagnosis: emptyToNull(z.string().trim().max(4000)).optional(),
    }).parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const job = await lockJob(ctx.tx, id);
      if (job.status === 'delivered' || job.status === 'cancelled') throw conflict(`${job.jobNo} is closed`);
      const patch: Partial<typeof jobCards.$inferInsert> = { updatedAt: new Date() };
      if (b.technician_id !== undefined) patch.technicianId = b.technician_id;
      if (b.promised_at !== undefined) patch.promisedAt = b.promised_at ? new Date(b.promised_at) : null;
      if (b.diagnosis !== undefined) patch.diagnosis = b.diagnosis;
      const [row] = await ctx.tx.update(jobCards).set(patch).where(eq(jobCards.id, id)).returning();
      await audit(ctx, 'job_card', id, 'update', job, row);
      return row;
    });
    res.json({ data: updated });
  });

  r.post('/jobs/:id/move', requirePerm('service:write'), async (req, res) => {
    const b = z.object({ to: z.enum(JOB_CARD_STATUSES), diagnosis: emptyToNull(z.string().trim().max(4000)).optional(), reason: emptyToNull(z.string().trim().max(500)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => moveJob(ctx, zId.parse(req.params.id), b.to, { diagnosis: b.diagnosis, reason: b.reason })) });
  });

  r.post('/jobs/:id/lines', requirePerm('service:write'), async (req, res) => {
    const b = z.object({ kind: z.enum(JOB_LINE_KINDS), item_id: zId, qty: zQty, rate: emptyToNull(zMoney).optional(), is_warranty: z.boolean().nullish() }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => addJobLine(ctx, zId.parse(req.params.id), { kind: b.kind, itemId: b.item_id, qty: b.qty, rate: b.rate, isWarranty: b.is_warranty })) });
  });

  r.delete('/jobs/:id/lines/:lineId', requirePerm('service:write'), async (req, res) => {
    await inTx(db, req, (ctx) => removeJobLine(ctx, zId.parse(req.params.id), zId.parse(req.params.lineId)));
    res.json({ ok: true });
  });

  r.post('/jobs/:id/lines/:lineId/issue', requirePerm('service:write'), async (req, res) => {
    const b = z.object({ qty: zQty, serials: zSerials.optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => issuePart(ctx, zId.parse(req.params.id), zId.parse(req.params.lineId), b)) });
  });

  r.post('/jobs/:id/faults', requirePerm('service:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ fault_code_id: zId, unit_id: emptyToNull(zId).optional(), notes: emptyToNull(z.string().trim().max(500)).optional() }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const job = await lockJob(ctx.tx, id);
      const [code] = await ctx.tx.select().from(faultCodes).where(eq(faultCodes.id, b.fault_code_id));
      if (!code?.active) throw badRequest('Fault code not found');
      if (b.unit_id && b.unit_id !== job.unitId) {
        const { descendants } = await genealogy(ctx.tx, job.unitId);
        if (!(descendants as { id: string }[]).some((d) => d.id === b.unit_id)) throw badRequest('That is not this unit or a component inside it');
      }
      const [made] = await ctx.tx.insert(jobCardFaults).values({ jobCardId: id, faultCodeId: code.id, unitId: b.unit_id ?? null, notes: b.notes ?? null, createdBy: ctx.user?.id ?? null }).returning();
      await audit(ctx, 'job_card', id, 'add_fault', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });

  r.post('/jobs/:id/media', requirePerm('service:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ file_id: zId, caption: emptyToNull(z.string().trim().max(200)).optional() }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      await lockJob(ctx.tx, id);
      const [made] = await ctx.tx.insert(jobCardMedia).values({ jobCardId: id, fileId: b.file_id, caption: b.caption ?? null, createdBy: ctx.user?.id ?? null }).returning();
      return made;
    });
    res.status(201).json({ data: row });
  });

  r.post('/jobs/:id/deliver', requirePerm('service:write'), async (req, res) => {
    res.json({ data: await inTx(db, req, (ctx) => deliverJob(ctx, zId.parse(req.params.id))) });
  });

  /** The warranty of a unit by serial, today: for the counter, before a job is opened. */
  r.get('/warranty', requirePerm('service:read'), async (req, res) => {
    const q = z.object({ serial: zText(60), item_id: zId.optional(), km: zReading.optional(), cycles: zReading.optional() }).parse(req.query);
    const unit = await unitBySerial(db, q.serial, q.item_id);
    res.json({ data: await warrantyFor(db, unit.id, istDate(), { km: q.km, cycles: q.cycles }) });
  });

  // ---- warranty rules and fault codes ----
  r.get('/warranty-rules', requirePerm('service:read'), async (req, res) => {
    sendList(req, res, await rows(db, sql`
      select w.*, i.name as item_name, i.sku from warranty_rules w join items i on i.id = w.item_id where w.active order by i.name`), 'warranty-rules');
  });
  r.post('/warranty-rules', requirePerm('service:approve'), async (req, res) => {
    const b = z.object({
      item_id: zId, months: z.coerce.number().int().min(1).max(240), km_limit: emptyToNull(z.coerce.number().int().min(1).max(10_000_000)).optional(),
      cycle_limit: emptyToNull(z.coerce.number().int().min(1).max(1_000_000)).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [item] = await ctx.tx.select().from(items).where(eq(items.id, b.item_id));
      if (!item) throw badRequest('Item not found');
      // A new rule for an item replaces the one before it; the old one stays on record.
      await ctx.tx.update(warrantyRules).set({ active: false, updatedAt: new Date() }).where(and(eq(warrantyRules.itemId, b.item_id), eq(warrantyRules.active, true)));
      const [made] = await ctx.tx.insert(warrantyRules).values({ itemId: b.item_id, months: b.months, kmLimit: b.km_limit ?? null, cycleLimit: b.cycle_limit ?? null, createdBy: ctx.user!.id }).returning();
      await audit(ctx, 'warranty_rule', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });
  r.get('/fault-codes', requirePerm('service:read'), async (req, res) => {
    sendList(req, res, await db.select().from(faultCodes).orderBy(asc(faultCodes.component), asc(faultCodes.code)), 'fault-codes');
  });
  r.post('/fault-codes', requirePerm('service:approve'), async (req, res) => {
    const b = z.object({ code: zText(30).transform((s) => s.toUpperCase()), component: zText(100), description: zText(300) }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [made] = await ctx.tx.insert(faultCodes).values({ ...b, createdBy: ctx.user!.id }).returning();
      await audit(ctx, 'fault_code', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });
  r.patch('/fault-codes/:id', requirePerm('service:approve'), async (req, res) => {
    const b = z.object({ description: zText(300).optional(), active: z.boolean().optional() }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [made] = await ctx.tx.update(faultCodes).set({ ...b, updatedAt: new Date() }).where(eq(faultCodes.id, zId.parse(req.params.id))).returning();
      must(made, 'Fault code');
      await audit(ctx, 'fault_code', made!.id, 'update', null, b);
      return made;
    });
    res.json({ data: row });
  });

  // ---- supplier claims ----
  r.get('/claims', requirePerm('service:read'), async (req, res) => {
    const q = z.object({ status: z.enum(CLAIM_STATUSES).optional() }).parse(req.query);
    sendList(req, res, await rows(db, sql`
      select c.*, j.job_no, u.serial_no, i.name as item_name, p.name as supplier_name, b.batch_no
        from supplier_claims c join job_cards j on j.id = c.job_card_id join units u on u.id = c.unit_id join items i on i.id = u.item_id
        join parties p on p.id = c.supplier_id left join batches b on b.id = u.batch_id
       where (${q.status ?? null}::text is null or c.status::text = ${q.status ?? null})
       order by c.created_at desc limit 500`), 'supplier-claims');
  });
  r.post('/claims', requirePerm('service:approve'), async (req, res) => {
    const b = z.object({ job_card_id: zId, unit_id: zId, supplier_id: zId, amount: emptyToNull(zMoney).optional(), notes: emptyToNull(z.string().trim().max(1000)).optional() }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => createClaim(ctx, { jobCardId: b.job_card_id, unitId: b.unit_id, supplierId: b.supplier_id, amount: b.amount, notes: b.notes })) });
  });
  r.post('/claims/:id/move', requirePerm('service:approve'), async (req, res) => {
    const b = z.object({ to: z.enum(CLAIM_STATUSES), amount: emptyToNull(zMoney).optional(), credit_note_ref: emptyToNull(z.string().trim().max(60)).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => moveClaim(ctx, zId.parse(req.params.id), b.to, { amount: b.amount, creditNoteRef: b.credit_note_ref })) });
  });

  // ---- reports (the brief's three) ----
  const zRange = z.object({ from: zDate.prefault(() => `${istDate().slice(0, 7)}-01`), to: zDate.prefault(() => istDate()) });

  /** Service history by serial: every job on the unit, on what it is fitted in, and on the components inside it. */
  r.get('/reports/history', requirePerm('service:read'), async (req, res) => {
    const q = z.object({ serial: zText(60), item_id: zId.optional() }).parse(req.query);
    const unit = await unitBySerial(db, q.serial, q.item_id);
    const { ancestors, descendants } = await genealogy(db, unit.id);
    const ids = [unit.id, ...(ancestors as { id: string }[]).map((a) => a.id), ...(descendants as { id: string }[]).map((d) => d.id)];
    sendList(req, res, await rows(db, sql`
      select j.id, j.job_no, j.status, j.created_at, j.closed_at, j.complaint, j.diagnosis, u.serial_no, i.name as item_name,
             (select coalesce(string_agg(c.code, ', '), '') from job_card_faults f join fault_codes c on c.id = f.fault_code_id where f.job_card_id = j.id) as faults
        from job_cards j join units u on u.id = j.unit_id join items i on i.id = u.item_id
       where j.unit_id in ${ids} order by j.created_at desc`), `service-history-${unit.serialNo}`);
  });

  /** Jobs per technician per day, with the turnaround (hours from taken in to handed back), and the comebacks. */
  r.get('/reports/technicians', requirePerm('service:read'), async (req, res) => {
    const q = zRange.parse(req.query);
    sendList(req, res, await rows(db, sql`
      select (j.closed_at at time zone 'Asia/Kolkata')::date as day, coalesce(t.name, 'Not assigned') as technician, count(*)::int as jobs,
             round(avg(extract(epoch from (j.closed_at - j.created_at)) / 3600)::numeric, 1) as turnaround_hours
        from job_cards j left join users t on t.id = j.technician_id
       where j.status = 'delivered' and (j.closed_at at time zone 'Asia/Kolkata')::date between ${q.from}::date and ${q.to}::date
       group by 1, 2 order by 1 desc, 2`), 'technicians');
  });

  /** Comebacks: the same unit on a new job card within 30 days of the last one being handed back. */
  r.get('/reports/comebacks', requirePerm('service:read'), async (req, res) => {
    const q = zRange.parse(req.query);
    sendList(req, res, await rows(db, sql`
      select j.id, j.job_no, j.created_at, j.complaint, u.serial_no, i.name as item_name, prev.job_no as previous_job_no,
             pt.name as previous_technician, extract(day from (j.created_at - prev.closed_at))::int as days_after
        from job_cards j join units u on u.id = j.unit_id join items i on i.id = u.item_id
        join lateral (
          select p.job_no, p.closed_at, p.technician_id from job_cards p
           where p.unit_id = j.unit_id and p.id <> j.id and p.status = 'delivered' and p.closed_at < j.created_at
           order by p.closed_at desc limit 1
        ) prev on prev.closed_at > j.created_at - interval '30 days'
        left join users pt on pt.id = prev.technician_id
       where (j.created_at at time zone 'Asia/Kolkata')::date between ${q.from}::date and ${q.to}::date
       order by j.created_at desc`), 'comebacks');
  });

  /** Failures by model (the unit's item), by component (the fault codes) and by batch (of the unit a fault was found in). */
  r.get('/reports/failures', requirePerm('service:read'), async (req, res) => {
    const q = zRange.parse(req.query);
    const inRange = sql`(j.created_at at time zone 'Asia/Kolkata')::date between ${q.from}::date and ${q.to}::date`;
    res.json({
      data: {
        by_model: await rows(db, sql`
          select i.name as model, count(*)::int as jobs from job_cards j join units u on u.id = j.unit_id join items i on i.id = u.item_id
           where ${inRange} group by i.name order by 2 desc`),
        by_component: await rows(db, sql`
          select c.component, c.code, c.description, count(*)::int as times from job_card_faults f join fault_codes c on c.id = f.fault_code_id
            join job_cards j on j.id = f.job_card_id where ${inRange} group by c.component, c.code, c.description order by 4 desc`),
        by_batch: await rows(db, sql`
          select i.name as part, b.batch_no, s.name as supplier, count(*)::int as faults
            from job_card_faults f join job_cards j on j.id = f.job_card_id join units u on u.id = coalesce(f.unit_id, j.unit_id)
            join items i on i.id = u.item_id join batches b on b.id = u.batch_id left join parties s on s.id = b.supplier_id
           where ${inRange} group by i.name, b.batch_no, s.name order by 4 desc`),
      },
      from: q.from, to: q.to,
    });
  });
  return r;
}

/** The customer's view of an estimate, from its link (the invoice link pattern): no sign-in, only the estimate. */
export function publicEstimateRouter(db: DB) {
  const r = Router();
  r.get('/:token', async (req, res) => {
    const [found] = await db.select({ id: jobCards.id }).from(jobCards).where(eq(jobCards.estimateToken, String(req.params.token)));
    if (!found) throw must(null, 'This estimate');
    const d = await jobDocument(db, found.id) as Record<string, any>;
    const company = await getCompany(db, d.entityId);
    res.json({
      data: {
        job_no: d.jobNo, status: d.status, party_name: d.party_name, item_name: d.item_name, serial_no: d.serial_no, complaint: d.complaint,
        diagnosis: d.diagnosis, approved_at: d.approvedAt,
        lines: d.lines.map((l: any) => ({ kind: l.kind, item_name: l.item_name, qty: l.qty, rate: l.rate, is_warranty: l.is_warranty, line_total: l.line_total })),
        chargeable: d.chargeable, free: d.free, company: { name: company.name, phone: company.phone ?? null },
      },
    });
  });
  const answer = (approve: boolean) => async (req: Parameters<Parameters<typeof r.post>[1]>[0], res: Parameters<Parameters<typeof r.post>[1]>[1]) => {
    await inTx(db, req, (ctx) => answerByLink(ctx, String(req.params.token), approve));
    res.json({ ok: true });
  };
  r.post('/:token/approve', answer(true));
  r.post('/:token/decline', answer(false));
  return r;
}

