import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, Decimal, STATE_CODES, addMonths, formatDate, fyOf, fyRange, istDate, money, qty as fmtQty, round2 } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal, reverseJournals } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { getCompany } from '../core/settings';
import { locationByType, lockItems, onHand, stockOut, valuation } from '../core/stock';
import { rows, type DB } from '../db/client';
import { jobWorkLines, jobWorkReceiptLines, jobWorkReceipts, jobWorks, locations, parties, stockMovements } from '../db/schema';
import { assertOnce, badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zMoney, zQty, zQtyNonNeg, zText, type Ctx } from '../lib/http';

/**
 * Job work: our material sent to an outside worker to be worked on, and what comes back.
 *
 * The material never stops being ours. Sending it out moves it, at the value it stands at, to
 * the "With job workers" place in stock, so it is no longer counted as on our shelves but is
 * still in Stock in Hand. Each challan then has to be accounted for unit by unit. What was sent
 * either
 *   - comes back as the same item (goods sent for coating, painting, repair),
 *   - is used up in making something else, which comes back valued at what was used, or
 *   - is lost, and is written off.
 * The job worker's charge can be added to the cost of what came back. It is then owed until
 * the job worker's bill is booked against the challan (see createPurchaseBill).
 */

type JobWork = typeof jobWorks.$inferSelect;

// ---------------------------------------------------------------------------
// Where a challan stands
// ---------------------------------------------------------------------------
/** Under GST, inputs sent for job work must be back within a year, or the sending counts as a sale. */
export const dueBackBy = (challanDate: string): string => addMonths(challanDate, 12);

export type LineState = {
  id: string; item_id: string; sku: string; name: string; unit: string; hsn_sac: string | null; gst_rate: string;
  qty: string; unit_cost: string; value: string; returned: string; consumed: string; lost: string; pending: string;
};

/** Each challan line with how much has come back, been used and been lost on the receipts that still stand. */
export function lineState(tx: DB, jobWorkId: string): Promise<LineState[]> {
  return rows<LineState>(tx, sql`
    select l.id, l.item_id, i.sku, i.name, i.unit, i.hsn_sac, i.gst_rate::text as gst_rate,
           l.qty::text as qty, l.unit_cost::text as unit_cost, l.value::text as value,
           coalesce(x.returned, 0)::numeric(12,3)::text as returned, coalesce(x.consumed, 0)::numeric(12,3)::text as consumed,
           coalesce(x.lost, 0)::numeric(12,3)::text as lost,
           (l.qty - coalesce(x.returned, 0) - coalesce(x.consumed, 0) - coalesce(x.lost, 0))::numeric(12,3)::text as pending
      from job_work_lines l join items i on i.id = l.item_id
      left join (
        select rl.job_work_line_id, sum(rl.qty) filter (where rl.kind = 'returned') as returned,
               sum(rl.qty) filter (where rl.kind = 'consumed') as consumed, sum(rl.qty) filter (where rl.kind = 'lost') as lost
          from job_work_receipt_lines rl join job_work_receipts r on r.id = rl.receipt_id
         where r.job_work_id = ${jobWorkId} and r.status = 'posted' group by rl.job_work_line_id
      ) x on x.job_work_line_id = l.id
     where l.job_work_id = ${jobWorkId} order by i.name`);
}

/** Charges added to the cost of goods on this challan's receipts, and how much of that the job worker's bills have settled. */
export async function chargeState(tx: DB, jobWorkId: string): Promise<{ added: Decimal; billed: Decimal }> {
  const [r] = await rows<{ added: string; billed: string }>(tx, sql`
    select (select coalesce(sum(charge), 0) from job_work_receipts where job_work_id = ${jobWorkId} and status = 'posted')::text as added,
           (select coalesce(sum(job_work_cleared), 0) from purchase_bills where job_work_id = ${jobWorkId} and status = 'posted')::text as billed`);
  return { added: D(r?.added ?? 0), billed: D(r?.billed ?? 0) };
}

/** What an item stands at per unit in the books right now. */
async function averageCost(tx: DB, item: { id: string; purchaseCost: string }): Promise<Decimal> {
  const v = await valuation(tx, item.id);
  return v.qty.gt(0) && v.value.gt(0) ? round2(v.value.div(v.qty)) : round2(item.purchaseCost);
}

async function place(tx: DB, id: string) {
  const [loc] = await tx.select().from(locations).where(eq(locations.id, id));
  if (!loc || !loc.active) throw badRequest('Location not found');
  if (loc.type === 'job_work') throw badRequest('Pick one of our own locations');
  return loc;
}

// ---------------------------------------------------------------------------
// Sending material out
// ---------------------------------------------------------------------------
export type JobWorkInput = {
  jobWorkerId: string; fromLocationId: string; challanDate: string; process: string; expectedBackOn?: string | null;
  transport?: string | null; notes?: string | null; lines: { itemId: string; qty: string }[];
};

/** Send material out on a challan. It leaves the shelf it was on and is from then on "with job workers". */
export async function createJobWork(ctx: Ctx, input: JobWorkInput): Promise<JobWork> {
  const { tx } = ctx;
  const [worker] = await tx.select().from(parties).where(eq(parties.id, input.jobWorkerId));
  if (!worker || !worker.active) throw badRequest('Job worker not found');
  // The job worker bills us and is paid like any supplier, so that is what they are in the party list.
  if (worker.partyType !== 'supplier') throw badRequest(`${worker.name} is not a supplier. Add the job worker under Parties as a supplier.`);
  const from = await place(tx, input.fromLocationId);
  const away = await locationByType(tx, 'job_work');
  if (input.lines.length === 0) throw badRequest('Add at least one item');
  if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) throw badRequest('An item is listed twice. Put the whole quantity on one line.');
  if (input.challanDate > istDate()) throw badRequest('The challan cannot be dated in the future');
  if (input.expectedBackOn && input.expectedBackOn < input.challanDate) throw badRequest('The date it is expected back is before the challan date');

  const byId = new Map((await lockItems(tx, input.lines.map((l) => l.itemId))).map((i) => [i.id, i]));
  const { number } = await nextNumber(tx, 'job_work', input.challanDate);
  const [job] = await tx.insert(jobWorks).values({
    challanNo: number, challanDate: input.challanDate, jobWorkerId: worker.id, fromLocationId: from.id, process: input.process,
    expectedBackOn: input.expectedBackOn ?? null, transport: input.transport ?? null, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
  }).returning();
  const reason = `Sent to ${worker.name} for ${input.process} (${number})`;
  for (const l of input.lines) {
    const item = byId.get(l.itemId)!;
    if (!item.isStockItem) throw badRequest(`${item.name} is a service and has no stock to send`);
    // Units by serial do not go on a challan yet (repairs of serialised units come with the service module).
    if (item.isSerialised) throw badRequest(`${item.name} is kept by serial number and cannot go on a job work challan yet`);
    const q = D(l.qty);
    const available = await onHand(tx, item.id, from.id);
    // Only what is physically there can be sent: this never goes negative.
    if (available.lt(q)) throw conflict(`Only ${fmtQty(available)} of ${item.name} in ${from.name}`);
    const unitCost = await averageCost(tx, item);
    const value = round2(q.times(unitCost));
    const base = { itemId: item.id, unitCost: money(unitCost), movementType: 'job_work' as const, refType: 'job_work', refId: job!.id, reason, createdBy: ctx.user?.id ?? null };
    // Two rows of the same value: it has changed place, not worth, so the books need no entry.
    await tx.insert(stockMovements).values([
      { ...base, locationId: from.id, qty: fmtQty(q.neg()), value: money(value.neg()) },
      { ...base, locationId: away, qty: fmtQty(q), value: money(value) },
    ]);
    await tx.insert(jobWorkLines).values({ jobWorkId: job!.id, itemId: item.id, qty: fmtQty(q), unitCost: money(unitCost), value: money(value), createdBy: ctx.user?.id ?? null });
  }
  await audit(ctx, 'job_work', job!.id, 'create', null, { ...job, lines: input.lines });
  return job!;
}

/** A challan made by mistake, before anything has come back on it: the material goes back where it was. */
export async function cancelJobWork(ctx: Ctx, id: string, reason: string): Promise<JobWork> {
  const { tx } = ctx;
  const [job] = await tx.select().from(jobWorks).where(eq(jobWorks.id, id)).for('update');
  must(job, 'Job work challan');
  if (job!.status === 'cancelled') throw conflict('This challan is already cancelled');
  const [used] = await rows(tx, sql`select 1 as x from job_work_receipts where job_work_id = ${id} and status = 'posted' limit 1`);
  if (used) throw conflict('Something has already been recorded as back on this challan. Cancel those receipts first.');
  const lines = await tx.select().from(jobWorkLines).where(eq(jobWorkLines.jobWorkId, id));
  await lockItems(tx, lines.map((l) => l.itemId));
  const away = await locationByType(tx, 'job_work');
  for (const l of lines) {
    const base = { itemId: l.itemId, unitCost: l.unitCost, movementType: 'job_work' as const, refType: 'job_work', refId: id, reason: `Challan ${job!.challanNo} cancelled: ${reason}`, createdBy: ctx.user?.id ?? null };
    await tx.insert(stockMovements).values([
      { ...base, locationId: away, qty: fmtQty(D(l.qty).neg()), value: money(D(l.value).neg()) },
      { ...base, locationId: job!.fromLocationId, qty: l.qty, value: l.value },
    ]);
  }
  const [updated] = await tx.update(jobWorks).set({ status: 'cancelled', closedAt: new Date(), updatedAt: new Date() }).where(eq(jobWorks.id, id)).returning();
  await audit(ctx, 'job_work', id, 'cancel', { status: job!.status }, { status: 'cancelled', reason });
  return updated!;
}

// ---------------------------------------------------------------------------
// Recording what came back
// ---------------------------------------------------------------------------
export type ReceiveInput = {
  receivedOn: string; toLocationId: string; workerChallanNo?: string | null; charge?: string | null; notes?: string | null;
  /** For each challan line: how much came back as it is, how much was used up, how much is lost. */
  lines: { lineId: string; returned?: string | null; consumed?: string | null; lost?: string | null }[];
  /** What was made out of the material that was used up. */
  produced?: { itemId: string; qty: string } | null;
};

/** Record what came back on a challan. Closes the challan once every unit sent is accounted for. */
export async function receiveJobWork(ctx: Ctx, id: string, input: ReceiveInput) {
  const { tx } = ctx;
  const [job] = await tx.select().from(jobWorks).where(eq(jobWorks.id, id)).for('update');
  must(job, 'Job work challan');
  if (job!.status === 'cancelled') throw conflict('This challan is cancelled');
  if (job!.status === 'closed') throw conflict('Everything sent on this challan is already accounted for');
  assertOnce(input.lines, (l) => l.lineId, 'challan line');
  const to = await place(tx, input.toLocationId);
  if (input.receivedOn < job!.challanDate) throw badRequest(`This cannot be before the challan date (${formatDate(job!.challanDate)})`);
  if (input.receivedOn > istDate()) throw badRequest('The date cannot be in the future');
  const [worker] = await tx.select({ name: parties.name }).from(parties).where(eq(parties.id, job!.jobWorkerId));

  const state = new Map((await lineState(tx, id)).map((l) => [l.id, l]));
  type Part = { line: LineState; returned: Decimal; consumed: Decimal; lost: Decimal };
  const parts: Part[] = [];
  for (const l of input.lines) {
    const line = state.get(l.lineId);
    if (!line) throw badRequest('A line does not belong to this challan');
    if (parts.some((p) => p.line.id === line.id)) throw badRequest(`${line.name} is entered twice`);
    const part = { line, returned: D(l.returned ?? 0), consumed: D(l.consumed ?? 0), lost: D(l.lost ?? 0) };
    const total = part.returned.plus(part.consumed).plus(part.lost);
    if (total.isZero()) continue;
    if (total.gt(line.pending)) throw conflict(`Only ${fmtQty(line.pending)} ${line.unit} of ${line.name} is still with the job worker`);
    parts.push(part);
  }
  const anyConsumed = parts.some((p) => p.consumed.gt(0));
  const produced = input.produced && D(input.produced.qty).gt(0) ? input.produced : null;
  if (parts.length === 0) throw badRequest('Enter what came back, was used or was lost');
  if (produced && !anyConsumed) throw badRequest('Say how much of the material was used to make what came back');
  if (anyConsumed && !produced) throw badRequest('Say what was made from the material that was used up');
  const charge = D(input.charge ?? 0);
  const anyReturned = parts.some((p) => p.returned.gt(0));
  if (charge.gt(0) && !produced && !anyReturned) throw badRequest('A job charge can only be added to goods that came back');

  const itemIds = [...new Set([...parts.map((p) => p.line.item_id), ...(produced ? [produced.itemId] : [])])];
  const itemById = new Map((await lockItems(tx, itemIds)).map((i) => [i.id, i]));
  const made = produced ? itemById.get(produced.itemId)! : null;
  if (made && (!made.isStockItem || !made.active)) throw badRequest(`${made.name} cannot be taken into stock`);

  const away = await locationByType(tx, 'job_work');
  const { number } = await nextNumber(tx, 'job_work_receipt', input.receivedOn);
  const [receipt] = await tx.insert(jobWorkReceipts).values({
    receiptNo: number, jobWorkId: id, receivedOn: input.receivedOn, toLocationId: to.id, workerChallanNo: input.workerChallanNo ?? null,
    charge: money(charge), notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
  }).returning();
  const ref = { movementType: 'job_work' as const, refType: 'job_work_receipt', refId: receipt!.id };
  const from = `${worker?.name ?? 'the job worker'} (${job!.challanNo})`;
  const lineRows: (typeof jobWorkReceiptLines.$inferInsert)[] = [];

  // Lost and used-up material leaves stock at what it stands at.
  let lossValue = D(0);
  let usedValue = D(0);
  for (const p of parts) {
    if (p.lost.gt(0)) {
      const out = await stockOut(ctx, { ...ref, itemId: p.line.item_id, locationId: away, qty: p.lost, reason: `Lost at ${from}`, itemName: p.line.name });
      lossValue = lossValue.plus(out.value);
      lineRows.push({ receiptId: receipt!.id, kind: 'lost', jobWorkLineId: p.line.id, itemId: p.line.item_id, qty: fmtQty(p.lost), value: money(out.value) });
    }
    if (p.consumed.gt(0)) {
      const out = await stockOut(ctx, { ...ref, itemId: p.line.item_id, locationId: away, qty: p.consumed, reason: `Used at ${from} to make ${made!.name}`, itemName: p.line.name });
      usedValue = usedValue.plus(out.value);
      lineRows.push({ receiptId: receipt!.id, kind: 'consumed', jobWorkLineId: p.line.id, itemId: p.line.item_id, qty: fmtQty(p.consumed), value: money(out.value) });
    }
  }

  // Material that came back as it is changes place at the value it stands at. With nothing made, the
  // charge is spread over these lines by value; the last one takes what rounding leaves.
  const back: { p: Part; value: Decimal }[] = [];
  for (const p of parts) {
    if (p.returned.lte(0)) continue;
    const v = await valuation(tx, p.line.item_id);
    const value = v.qty.gt(0) && v.value.gt(0) ? (p.returned.eq(v.qty) ? v.value : round2(p.returned.times(v.value).div(v.qty))) : round2(p.returned.times(p.line.unit_cost));
    back.push({ p, value });
  }
  const backTotal = back.reduce((s, b) => s.plus(b.value), D(0));
  const backQty = back.reduce((s, b) => s.plus(b.p.returned), D(0));
  let shared = D(0);
  for (const [i, b] of back.entries()) {
    let share = D(0);
    if (charge.gt(0) && !produced) {
      share = i === back.length - 1 ? charge.minus(shared)
        : round2(backTotal.gt(0) ? charge.times(b.value).div(backTotal) : charge.times(b.p.returned).div(backQty));
      shared = shared.plus(share);
    }
    const inValue = b.value.plus(share);
    const base = { ...ref, itemId: b.p.line.item_id, createdBy: ctx.user?.id ?? null };
    await tx.insert(stockMovements).values([
      { ...base, locationId: away, qty: fmtQty(b.p.returned.neg()), unitCost: money(b.value.div(b.p.returned)), value: money(b.value.neg()), reason: `Back from ${from}` },
      { ...base, locationId: to.id, qty: fmtQty(b.p.returned), unitCost: money(inValue.div(b.p.returned)), value: money(inValue), reason: `Back from ${from}` },
    ]);
    lineRows.push({ receiptId: receipt!.id, kind: 'returned', jobWorkLineId: b.p.line.id, itemId: b.p.line.item_id, qty: fmtQty(b.p.returned), value: money(b.value), chargeShare: money(share) });
  }

  // What was made comes in worth exactly what was used to make it, plus the charge.
  if (made) {
    const q = D(produced!.qty);
    const value = usedValue.plus(charge);
    await tx.insert(stockMovements).values({
      ...ref, itemId: made.id, locationId: to.id, qty: fmtQty(q), unitCost: money(value.div(q)), value: money(value),
      reason: `Made by ${from}`, createdBy: ctx.user?.id ?? null,
    });
    lineRows.push({ receiptId: receipt!.id, kind: 'produced', jobWorkLineId: null, itemId: made.id, qty: fmtQty(q), value: money(value) });
  }
  await tx.insert(jobWorkReceiptLines).values(lineRows);

  // The books: a loss is an expense; a charge added to the goods is owed until the job worker's bill comes.
  await postJournal(ctx, {
    date: input.receivedOn, refType: 'job_work_receipt', refId: receipt!.id,
    narration: `Job work ${job!.challanNo}: ${number} from ${worker?.name ?? 'job worker'}`,
    lines: [
      { account: 'stock_adjustment', debit: lossValue, memo: 'Material lost at the job worker' },
      { account: 'stock', credit: lossValue },
      { account: 'stock', debit: charge, memo: 'Job charge added to the cost of the goods' },
      { account: 'job_work_accrued', partyId: job!.jobWorkerId, credit: charge },
    ],
  });

  const left = (await lineState(tx, id)).some((l) => D(l.pending).gt(0));
  if (!left) await tx.update(jobWorks).set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() }).where(eq(jobWorks.id, id));
  await audit(ctx, 'job_work_receipt', receipt!.id, 'create', null, { ...receipt, lines: lineRows.map((l) => ({ kind: l.kind, itemId: l.itemId, qty: l.qty, value: l.value })) });
  return { ...receipt!, closed: !left };
}

/** Undo a receipt entered wrongly: every movement it made is mirrored, as long as the goods are still where it put them. */
export async function cancelReceipt(ctx: Ctx, receiptId: string, reason: string): Promise<void> {
  const { tx } = ctx;
  const [receipt] = await tx.select().from(jobWorkReceipts).where(eq(jobWorkReceipts.id, receiptId)).for('update');
  must(receipt, 'Receipt');
  if (receipt!.status !== 'posted') throw conflict('This receipt is already cancelled');
  const [job] = await tx.select().from(jobWorks).where(eq(jobWorks.id, receipt!.jobWorkId)).for('update');
  if (D(receipt!.charge).gt(0)) {
    const c = await chargeState(tx, job!.id);
    if (c.billed.gt(c.added.minus(receipt!.charge))) throw conflict('The job worker’s bill has already been booked against this charge. Cancel that bill first.');
  }
  const lines = await tx.select().from(jobWorkReceiptLines).where(eq(jobWorkReceiptLines.receiptId, receiptId));
  const itemById = new Map((await lockItems(tx, lines.map((l) => l.itemId))).map((i) => [i.id, i]));
  const [to] = await tx.select().from(locations).where(eq(locations.id, receipt!.toLocationId));
  const away = await locationByType(tx, 'job_work');
  const base = { movementType: 'job_work' as const, refType: 'job_work_receipt', refId: receiptId, reason: `Receipt ${receipt!.receiptNo} cancelled: ${reason}`, createdBy: ctx.user?.id ?? null };
  for (const l of lines) {
    const q = D(l.qty);
    const unit = (value: Decimal) => money(value.div(q));
    if (l.kind === 'returned' || l.kind === 'produced') {
      const here = await onHand(tx, l.itemId, receipt!.toLocationId);
      if (here.lt(q)) {
        throw conflict(`Only ${fmtQty(here)} of ${itemById.get(l.itemId)!.name} is left in ${to?.name ?? 'that location'}; the rest has moved on, so this receipt cannot be undone. Put the difference right with a stock adjustment.`);
      }
      const inValue = D(l.value).plus(l.chargeShare ?? 0);
      await tx.insert(stockMovements).values({ ...base, itemId: l.itemId, locationId: receipt!.toLocationId, qty: fmtQty(q.neg()), unitCost: unit(inValue), value: money(inValue.neg()) });
    }
    if (l.kind !== 'produced') {
      // Back to being with the job worker, at the value it left at.
      await tx.insert(stockMovements).values({ ...base, itemId: l.itemId, locationId: away, qty: fmtQty(q), unitCost: unit(D(l.value)), value: money(l.value) });
    }
  }
  await reverseJournals(ctx, 'job_work_receipt', receiptId, istDate(), `Cancelled ${receipt!.receiptNo}: ${reason}`);
  await tx.update(jobWorkReceipts).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(jobWorkReceipts.id, receiptId));
  if (job!.status === 'closed') await tx.update(jobWorks).set({ status: 'open', closedAt: null, updatedAt: new Date() }).where(eq(jobWorks.id, job!.id));
  await audit(ctx, 'job_work_receipt', receiptId, 'cancel', { status: 'posted' }, { status: 'cancelled', reason });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// A box left empty or at 0 means "none of this".
const zQtyOrBlank = emptyToNull(zQtyNonNeg).optional();

export function jobWorkRouter(db: DB) {
  const r = Router();

  /** The challans, newest first, with what is still out on each. */
  r.get('/', requirePerm('jobwork:read'), async (req, res) => {
    const q = z.object({ status: z.enum(['open', 'closed', 'cancelled']).optional(), q: z.string().trim().max(100).optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const today = istDate();
    const data = await rows(db, sql`
      select j.id, j.challan_no, j.challan_date, j.status, j.process, j.expected_back_on, p.name as job_worker_name, j.job_worker_id,
             s.sent_value, s.out_value, s.still_out,
             (${today}::date - j.challan_date)::int as days_out,
             (j.challan_date + interval '1 year')::date as due_back_by,
             (j.status = 'open' and j.expected_back_on is not null and j.expected_back_on < ${today}::date) as late,
             (j.status = 'open' and (j.challan_date + interval '1 year')::date < ${today}::date) as past_one_year
        from job_works j join parties p on p.id = j.job_worker_id
        join lateral (
          select sum(l.value)::numeric(14,2) as sent_value,
                 sum(round(pend.q * l.unit_cost, 2))::numeric(14,2) as out_value,
                 string_agg(trim(to_char(pend.q, 'FM999999990.###'), '.') || ' ' || i.unit || ' ' || i.name, ', ' order by i.name) filter (where pend.q > 0) as still_out
            from job_work_lines l join items i on i.id = l.item_id
            cross join lateral (
              select l.qty - coalesce((select sum(rl.qty) from job_work_receipt_lines rl join job_work_receipts rc on rc.id = rl.receipt_id
                                        where rl.job_work_line_id = l.id and rc.status = 'posted' and rl.kind <> 'produced'), 0) as q
            ) pend
           where l.job_work_id = j.id
        ) s on true
       where (${q.status ?? null}::text is null or j.status::text = ${q.status ?? null})
         and (${like}::text is null or j.challan_no ilike ${like} or p.name ilike ${like} or j.process ilike ${like})
       order by j.challan_date desc, j.challan_no desc limit 500`);
    if (req.query.format) return sendList(req, res, data.map(({ id: _i, job_worker_id: _w, ...x }: any) => x), 'job-work-challans');
    const [totals] = await rows(db, sql`
      select (select count(*)::int from job_works where status = 'open') as open_challans,
             -- at the value on the challans, the same figure each challan shows
             (select coalesce(sum(round(x.pending * x.unit_cost, 2)), 0)::numeric(14,2) from (
                select l.unit_cost, l.qty - coalesce((select sum(rl.qty) from job_work_receipt_lines rl join job_work_receipts rc on rc.id = rl.receipt_id
                                                       where rl.job_work_line_id = l.id and rc.status = 'posted' and rl.kind <> 'produced'), 0) as pending
                  from job_work_lines l join job_works j on j.id = l.job_work_id where j.status = 'open') x) as value_out,
             (select count(*)::int from job_works where status = 'open' and expected_back_on < ${today}::date) as late`);
    res.json({ data, totals });
  });

  /**
   * The two lists the GST job work return (ITC-04) is filled from: what was sent out in the
   * period, and what came back, was made, or was lost. This is the data, not the portal's file.
   */
  r.get('/register', requirePerm('jobwork:read'), async (req, res) => {
    const today = istDate();
    const q = z.object({ kind: z.enum(['sent', 'received']).prefault('sent'), from: zDate.prefault(() => fyRange(fyOf(today)).from), to: zDate.prefault(() => today) }).parse(req.query);
    const data = q.kind === 'sent'
      ? await rows(db, sql`
          select j.challan_no, j.challan_date, p.name as job_worker, p.gstin as job_worker_gstin, p.state_code as job_worker_state,
                 i.name as description, i.hsn_sac, i.unit, l.qty, l.value as taxable_value, i.gst_rate, j.process as nature_of_job_work
            from job_work_lines l join job_works j on j.id = l.job_work_id join parties p on p.id = j.job_worker_id join items i on i.id = l.item_id
           where j.status <> 'cancelled' and j.challan_date between ${q.from}::date and ${q.to}::date
           order by j.challan_date, j.challan_no, i.name`)
      : await rows(db, sql`
          select rc.receipt_no, rc.received_on, p.name as job_worker, p.gstin as job_worker_gstin, p.state_code as job_worker_state,
                 j.challan_no as original_challan_no, j.challan_date as original_challan_date, rc.worker_challan_no as job_worker_challan_no,
                 case rl.kind when 'returned' then 'Received back' when 'produced' then 'Received back, made from the material'
                              when 'consumed' then 'Used in what was made' else 'Lost or wasted' end as what,
                 i.name as description, i.hsn_sac, i.unit, rl.qty, j.process as nature_of_job_work
            from job_work_receipt_lines rl join job_work_receipts rc on rc.id = rl.receipt_id join job_works j on j.id = rc.job_work_id
            join parties p on p.id = j.job_worker_id join items i on i.id = rl.item_id
           where rc.status = 'posted' and rc.received_on between ${q.from}::date and ${q.to}::date
           order by rc.received_on, rc.receipt_no, rl.kind, i.name`);
    const named = data.map((x: any) => ({ ...x, job_worker_state: STATE_CODES[String(x.job_worker_state)] ?? x.job_worker_state }));
    if (req.query.format) return sendList(req, res, named, `job-work-${q.kind}-${q.from}-to-${q.to}`);
    res.json({ data: named, from: q.from, to: q.to });
  });

  /** A job worker's challans with a charge still waiting for the bill, for the bill form. */
  r.get('/for-billing', requirePerm('jobwork:read'), async (req, res) => {
    const q = z.object({ supplier_id: zId }).parse(req.query);
    res.json({ data: await rows(db, sql`
      select j.id, j.challan_no, j.challan_date, j.process,
             (coalesce((select sum(charge) from job_work_receipts where job_work_id = j.id and status = 'posted'), 0)
              - coalesce((select sum(job_work_cleared) from purchase_bills where job_work_id = j.id and status = 'posted'), 0))::numeric(12,2) as still_to_bill
        from job_works j where j.job_worker_id = ${q.supplier_id} and j.status <> 'cancelled' order by j.challan_date desc limit 200`) });
  });

  r.get('/:id', requirePerm('jobwork:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [job] = await rows<Record<string, any>>(db, sql`
      select j.*, p.name as job_worker_name, p.gstin as job_worker_gstin, p.phone as job_worker_phone, p.state_code as job_worker_state,
             p.billing_address as job_worker_address, l.name as from_location
        from job_works j join parties p on p.id = j.job_worker_id join locations l on l.id = j.from_location_id where j.id = ${id}`);
    must(job, 'Job work challan');
    const lines = await lineState(db, id);
    const receipts = await rows<Record<string, any>>(db, sql`
      select rc.id, rc.receipt_no, rc.received_on, rc.worker_challan_no, rc.charge, rc.notes, rc.status, l.name as to_location,
             (select coalesce(json_agg(json_build_object('kind', rl.kind, 'item', i.name, 'sku', i.sku, 'unit', i.unit, 'qty', rl.qty::text,
                       'value', (rl.value + rl.charge_share)::numeric(14,2)::text) order by rl.kind, i.name), '[]'::json)
                from job_work_receipt_lines rl join items i on i.id = rl.item_id where rl.receipt_id = rc.id) as lines
        from job_work_receipts rc join locations l on l.id = rc.to_location_id where rc.job_work_id = ${id} order by rc.received_on, rc.receipt_no`);
    const bills = await rows(db, sql`
      select id, bill_no, supplier_invoice_no, bill_date, taxable_total, grand_total, job_work_cleared, status
        from purchase_bills where job_work_id = ${id} order by bill_date`);
    const c = await chargeState(db, id);
    const today = istDate();
    res.json({
      data: {
        ...job, lines, receipts, bills,
        out_value: money(lines.reduce((s, l) => s.plus(round2(D(l.pending).times(l.unit_cost))), D(0))),
        charges: { added_to_cost: money(c.added), billed: money(c.billed), still_to_bill: money(c.added.minus(c.billed)) },
        due_back_by: dueBackBy(String(job!.challan_date)),
        days_out: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(job!.challan_date)}T00:00:00Z`)) / 86_400_000),
        company: await getCompany(db),
      },
    });
  });

  r.post('/', requirePerm('jobwork:write'), async (req, res) => {
    const b = z.object({
      job_worker_id: zId, from_location_id: zId, challan_date: zDate.prefault(() => istDate()), process: zText(200),
      expected_back_on: emptyToNull(zDate).optional(), transport: emptyToNull(z.string().trim().max(200)).optional(),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
      lines: z.array(z.object({ item_id: zId, qty: zQty })).min(1).max(200),
    }).parse(req.body);
    const job = await inTx(db, req, (ctx) => createJobWork(ctx, {
      jobWorkerId: b.job_worker_id, fromLocationId: b.from_location_id, challanDate: b.challan_date, process: b.process, expectedBackOn: b.expected_back_on,
      transport: b.transport, notes: b.notes, lines: b.lines.map((l) => ({ itemId: l.item_id, qty: l.qty })),
    }));
    res.status(201).json({ data: job });
  });

  r.post('/:id/cancel', requirePerm('jobwork:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(300) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => cancelJobWork(ctx, id, b.reason)) });
  });

  r.post('/:id/receipts', requirePerm('jobwork:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      received_on: zDate.prefault(() => istDate()), to_location_id: zId, worker_challan_no: emptyToNull(z.string().trim().max(60)).optional(),
      charge: emptyToNull(zMoney).optional(), notes: emptyToNull(z.string().trim().max(1000)).optional(),
      lines: z.array(z.object({ line_id: zId, returned: zQtyOrBlank, consumed: zQtyOrBlank, lost: zQtyOrBlank })).max(200).prefault([]),
      produced: z.object({ item_id: emptyToNull(zId).optional(), qty: zQtyOrBlank }).nullish(),
    }).parse(req.body);
    const produced = b.produced?.item_id && b.produced.qty ? { itemId: b.produced.item_id, qty: b.produced.qty } : null;
    if (b.produced?.qty && !b.produced.item_id) throw badRequest('Pick the item that was made');
    const receipt = await inTx(db, req, (ctx) => receiveJobWork(ctx, id, {
      receivedOn: b.received_on, toLocationId: b.to_location_id, workerChallanNo: b.worker_challan_no, charge: b.charge, notes: b.notes,
      lines: b.lines.map((l) => ({ lineId: l.line_id, returned: l.returned, consumed: l.consumed, lost: l.lost })), produced,
    }));
    res.status(201).json({ data: receipt });
  });

  r.post('/receipts/:id/cancel', requirePerm('jobwork:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(300) }).parse(req.body);
    await inTx(db, req, (ctx) => cancelReceipt(ctx, id, b.reason));
    res.json({ ok: true });
  });
  return r;
}
