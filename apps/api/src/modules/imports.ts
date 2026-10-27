import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  D, Decimal, IMPORT_STAGES, LANDED_COST_BASES, LANDED_COST_KINDS, istDate, money, qty as fmtQty, round2,
  type ImportStage, type LandedCostBasis, type LandedCostKind,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { assertGstOpen } from '../core/gst-lock';
import { assertMoneyAccount, postJournal, reverseJournals } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { lockItems, revalue } from '../core/stock';
import { rows, type DB } from '../db/client';
import {
  importShipmentOrders, importShipments, landedCostAllocations, landedCostApplications, landedCostLines, parties, purchaseOrders,
} from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, fxOf, inTx, sendList, zCurrency, zDate, zFxRate, zId, zListQuery, zMoneyPos, type Ctx } from '../lib/http';

/**
 * Imports and their landed cost (P2 of the founder's brief of 21 Oct 2026).
 *
 * - A shipment follows a foreign supplier's purchase orders from the proforma invoice to the goods received:
 *   pi -> advance_paid -> production -> shipped -> at_port -> boe_filed -> cleared -> received, with the day
 *   each stage was reached, the BL/AWB number, the bill of entry, and the documents.
 * - Its landed cost lines (freight, insurance, BCD, SWS, IGST, the customs agent, port, inland, other) come
 *   from money paid (customs duty on the bill of entry, port charges: Dr Landed Costs Clearing, Cr Cash or
 *   Bank) or from a supplier's bill that names the shipment (its service lines go to Landed Costs Clearing
 *   instead of Purchases: modules/purchasing.ts). IGST paid on import is input credit: Dr Input IGST, and it
 *   is never spread over the goods.
 * - Applying spreads each line over the shipment's goods receipt lines by its basis (value, quantity or
 *   weight), the rounding left on the last line, and books it: the share of goods still in stock onto the
 *   stock (a value-only revaluation row, so the moving average cost rises), the share already sold to Cost of
 *   Goods Sold, Cr Landed Costs Clearing. Applied lines never change; a correction is a new line.
 * - Supplier advances: money paid out to suppliers and not yet set against a bill, by age.
 */

type Shipment = typeof importShipments.$inferSelect;
type CostLine = typeof landedCostLines.$inferSelect;

async function lockShipment(tx: DB, id: string): Promise<Shipment> {
  const [s] = await tx.select().from(importShipments).where(eq(importShipments.id, id)).for('update');
  must(s, 'Import shipment');
  return s!;
}

/** The purchase orders a shipment carries: all of its supplier, none cancelled, none already on another shipment. */
async function checkOrders(tx: DB, supplierId: string, orderIds: string[], shipmentId: string | null) {
  if (orderIds.length === 0) return;
  const pos = await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.id, orderIds));
  if (pos.length !== new Set(orderIds).size) throw badRequest('Purchase order not found');
  const wrong = pos.find((p) => p.supplierId !== supplierId || p.status === 'cancelled' || p.status === 'draft');
  if (wrong) throw badRequest(`PO ${wrong.poNo} is ${wrong.supplierId !== supplierId ? 'for a different supplier' : wrong.status}`);
  const taken = await rows<{ po_no: string; shipment_no: string }>(tx, sql`
    select p.po_no, s.shipment_no from import_shipment_orders o join purchase_orders p on p.id = o.purchase_order_id
      join import_shipments s on s.id = o.shipment_id
     where o.purchase_order_id in ${orderIds} and (${shipmentId}::uuid is null or o.shipment_id <> ${shipmentId}::uuid)`);
  if (taken[0]) throw conflict(`PO ${taken[0].po_no} is already on shipment ${taken[0].shipment_no}`);
}

export async function createShipment(ctx: Ctx, input: {
  supplierId: string; purchaseOrderIds: string[]; currency?: string; fxRate?: string | null; blAwbNo?: string | null; notes?: string | null;
}): Promise<Shipment> {
  const { tx } = ctx;
  const [supplier] = await tx.select().from(parties).where(eq(parties.id, input.supplierId));
  if (supplier?.partyType !== 'supplier') throw badRequest('An import shipment comes from a supplier');
  await checkOrders(tx, supplier.id, input.purchaseOrderIds, null);
  const fx = fxOf(input.currency ?? 'USD', input.fxRate);
  const { number } = await nextNumber(tx, 'import_shipment', istDate());
  const [shipment] = await tx.insert(importShipments).values({
    shipmentNo: number, supplierId: supplier.id, currency: fx.currency, fxRate: input.fxRate ? fx.fxRate : null, blAwbNo: input.blAwbNo ?? null,
    notes: input.notes ?? null, stageDates: { pi: istDate() }, createdBy: ctx.user?.id ?? null,
  }).returning();
  if (input.purchaseOrderIds.length) {
    await tx.insert(importShipmentOrders).values([...new Set(input.purchaseOrderIds)].map((purchaseOrderId) => ({ shipmentId: shipment!.id, purchaseOrderId })));
  }
  await audit(ctx, 'import_shipment', shipment!.id, 'create', null, { ...shipment, orders: input.purchaseOrderIds });
  return shipment!;
}

/** Record that a shipment reached a stage, on a day (today unless given). */
export async function setStage(ctx: Ctx, id: string, stage: ImportStage, on?: string | null) {
  const { tx } = ctx;
  const s = await lockShipment(tx, id);
  const day = on ?? istDate();
  const [updated] = await tx.update(importShipments).set({ stage, stageDates: { ...s.stageDates, [stage]: day }, updatedAt: new Date() })
    .where(eq(importShipments.id, id)).returning();
  await audit(ctx, 'import_shipment', id, 'stage', { stage: s.stage }, { stage, on: day });
  return updated!;
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------
/**
 * A cost paid from a cash or bank account (the duty on the bill of entry, port charges paid there and then):
 * Dr Landed Costs Clearing, or Dr Input IGST for the IGST paid on import, Cr the account.
 */
export async function addPaidCost(ctx: Ctx, id: string, input: {
  kind: LandedCostKind; amount: string; basis?: LandedCostBasis; description?: string | null; paidFromAccountId: string; paidOn?: string | null;
}): Promise<CostLine> {
  const { tx } = ctx;
  const s = await lockShipment(tx, id);
  await assertMoneyAccount(tx, input.paidFromAccountId);
  // IGST paid at customs is input credit in that month's GSTR-3B: not once that return is filed.
  if (input.kind === 'igst') await assertGstOpen(tx, input.paidOn ?? istDate(), 'purchases', 'no IGST paid at customs can be dated in it');
  const [line] = await tx.insert(landedCostLines).values({
    shipmentId: s.id, kind: input.kind, amount: money(input.amount), basis: input.basis ?? 'value', description: input.description ?? null,
    paidFromAccountId: input.paidFromAccountId, createdBy: ctx.user?.id ?? null,
  }).returning();
  await postJournal(ctx, {
    date: input.paidOn ?? istDate(), refType: 'landed_cost_line', refId: line!.id, entityId: s.entityId,
    narration: `${input.kind.toUpperCase()} for import ${s.shipmentNo}${input.description ? `: ${input.description}` : ''}`,
    lines: [{ account: input.kind === 'igst' ? 'input_igst' : 'landed_cost_clearing', debit: input.amount }, { account: { id: input.paidFromAccountId }, credit: input.amount }],
  });
  await audit(ctx, 'import_shipment', s.id, 'add_cost', null, line);
  return line!;
}

async function openLine(tx: DB, shipmentId: string, lineId: string): Promise<CostLine> {
  const [line] = await tx.select().from(landedCostLines).where(and(eq(landedCostLines.id, lineId), eq(landedCostLines.shipmentId, shipmentId))).for('update');
  must(line, 'Cost line');
  if (line!.applicationId) throw conflict('This cost is already on the goods and cannot change: add a correcting line instead');
  return line!;
}

/** Change how a cost not yet applied is spread, or what kind it is. */
export async function changeCost(ctx: Ctx, shipmentId: string, lineId: string, input: { kind?: LandedCostKind; basis?: LandedCostBasis }) {
  const line = await openLine(ctx.tx, shipmentId, lineId);
  if (input.kind && (input.kind === 'igst') !== (line.kind === 'igst') && line.paidFromAccountId) {
    throw badRequest('IGST is booked as input credit when paid: remove the line and enter it again');
  }
  const [updated] = await ctx.tx.update(landedCostLines).set({ ...input, updatedAt: new Date() }).where(eq(landedCostLines.id, lineId)).returning();
  await audit(ctx, 'import_shipment', shipmentId, 'change_cost', line, input);
  return updated!;
}

/** Take off a paid cost not yet applied: its entry is reversed. A bill's costs go with the bill (cancel the bill). */
export async function removeCost(ctx: Ctx, shipmentId: string, lineId: string) {
  const line = await openLine(ctx.tx, shipmentId, lineId);
  if (line.purchaseBillId) throw conflict('This cost came from a supplier\'s bill: cancel the bill to take it off');
  if (line.kind === 'igst') {
    const [paid] = await rows<{ d: string }>(ctx.tx, sql`select entry_date::text as d from journal_entries where ref_type = 'landed_cost_line' and ref_id = ${line.id} and reverses_entry_id is null limit 1`);
    if (paid) await assertGstOpen(ctx.tx, paid.d, 'purchases', 'the IGST paid at customs in it cannot be taken off');
  }
  await reverseJournals(ctx, 'landed_cost_line', line.id, istDate(), 'Cost line removed from the shipment');
  await ctx.tx.delete(landedCostLines).where(eq(landedCostLines.id, lineId));
  await audit(ctx, 'import_shipment', shipmentId, 'remove_cost', line, null);
}

// ---------------------------------------------------------------------------
// Spreading the costs over the goods
// ---------------------------------------------------------------------------
type Good = { grn_line_id: string; grn_id: string; grn_no: string; item_id: string; item_name: string; sku: string; accepted: string; rate: string; weight_kg: string | null };

/** The shipment's goods: accepted quantities on the goods receipts of its purchase orders, after QC. */
async function goodsOf(tx: DB, shipmentId: string): Promise<Good[]> {
  return rows<Good>(tx, sql`
    select gl.id as grn_line_id, g.id as grn_id, g.grn_no, gl.item_id, i.name as item_name, i.sku, gl.accepted_qty::text as accepted, gl.rate::text, i.weight_kg::text
      from import_shipment_orders o join goods_receipts g on g.purchase_order_id = o.purchase_order_id
      join goods_receipt_lines gl on gl.grn_id = g.id join items i on i.id = gl.item_id
     where o.shipment_id = ${shipmentId} and g.status = 'inwarded' and gl.accepted_qty > 0
     order by g.grn_no, i.name`);
}

/** One cost line spread over the goods by its basis; the paisa left by rounding goes to the last line. */
function spread(line: Pick<CostLine, 'amount' | 'basis'>, goods: Good[]): { grnLineId: string; itemId: string; amount: Decimal }[] {
  const base = (g: Good) => {
    if (line.basis === 'qty') return D(g.accepted);
    if (line.basis === 'weight') {
      if (!g.weight_kg) throw badRequest(`${g.item_name} has no weight per unit: add it to the product to spread by weight`);
      return D(g.accepted).times(g.weight_kg);
    }
    return D(g.accepted).times(g.rate);
  };
  const total = goods.reduce((a, g) => a.plus(base(g)), D(0));
  if (total.lte(0)) throw badRequest('The goods have nothing to spread this cost over');
  let left = D(line.amount);
  return goods.map((g, i) => {
    const amount = i === goods.length - 1 ? left : round2(D(line.amount).times(base(g)).div(total));
    left = left.minus(amount);
    return { grnLineId: g.grn_line_id, itemId: g.item_id, amount };
  });
}

/**
 * How much of each item from this shipment is still held: its stock today (outside Rejected), at most what the shipment
 * brought in. The rest has been sold (moving average makes no difference which units went).
 */
async function heldShare(tx: DB, goods: Good[]): Promise<Map<string, Decimal>> {
  const share = new Map<string, Decimal>();
  for (const itemId of new Set(goods.map((g) => g.item_id))) {
    const inShipment = goods.filter((g) => g.item_id === itemId).reduce((a, g) => a.plus(g.accepted), D(0));
    // Goods turned away at QC lie in Rejected and go back to the supplier: they carry none of the landed cost.
    const [r] = await rows<{ q: string }>(tx, sql`
      select coalesce(sum(m.qty), 0)::text as q from stock_movements m join locations l on l.id = m.location_id
       where m.item_id = ${itemId} and l.type <> 'rejected'`);
    const held = Decimal.max(0, Decimal.min(D(r?.q ?? 0), inShipment));
    share.set(itemId, inShipment.gt(0) ? held.div(inShipment) : D(0));
  }
  return share;
}

/** What applying the open costs would do, line by line and item by item. */
export async function previewCosts(tx: DB, shipmentId: string) {
  const lines = await tx.select().from(landedCostLines)
    .where(and(eq(landedCostLines.shipmentId, shipmentId), isNull(landedCostLines.applicationId)));
  const toSpread = lines.filter((l) => l.kind !== 'igst');
  const goods = await goodsOf(tx, shipmentId);
  if (toSpread.length === 0) return { lines: [], items: [], total: '0.00', goods };
  if (goods.length === 0) throw conflict('No goods of this shipment have passed QC yet: the costs are spread once they are in stock');
  const share = await heldShare(tx, goods);
  const perItem = new Map<string, { item_id: string; item_name: string; qty: Decimal; amount: Decimal; toStock: Decimal }>();
  const allocations = [];
  for (const line of toSpread) {
    for (const a of spread(line, goods)) {
      const toStock = round2(a.amount.times(share.get(a.itemId)!));
      allocations.push({ costLineId: line.id, ...a, toStock, toCogs: a.amount.minus(toStock) });
      const g = goods.find((x) => x.grn_line_id === a.grnLineId)!;
      const row = perItem.get(a.itemId) ?? { item_id: a.itemId, item_name: g.item_name, qty: D(0), amount: D(0), toStock: D(0) };
      row.amount = row.amount.plus(a.amount); row.toStock = row.toStock.plus(toStock);
      perItem.set(a.itemId, row);
    }
  }
  for (const row of perItem.values()) row.qty = goods.filter((g) => g.item_id === row.item_id).reduce((a, g) => a.plus(g.accepted), D(0));
  const total = toSpread.reduce((a, l) => a.plus(l.amount), D(0));
  return {
    lines: toSpread, allocations, goods, total: money(total),
    items: [...perItem.values()].map((r) => ({
      item_id: r.item_id, item_name: r.item_name, qty: fmtQty(r.qty), amount: money(r.amount), to_stock: money(r.toStock),
      to_cogs: money(r.amount.minus(r.toStock)), per_unit: money(r.amount.div(r.qty)),
    })),
  };
}

/** Put the open costs on the goods: Dr Stock (the share still held) and Cost of Goods Sold (the share sold), Cr Landed Costs Clearing. */
export async function applyCosts(ctx: Ctx, shipmentId: string) {
  const { tx } = ctx;
  const s = await lockShipment(tx, shipmentId);
  const plan = await previewCosts(tx, shipmentId);
  if (!plan.allocations?.length) throw conflict('There are no costs waiting to be put on the goods');
  await lockItems(tx, plan.items.map((i) => i.item_id));
  const total = D(plan.total);
  const toStock = plan.items.reduce((a, i) => a.plus(i.to_stock), D(0));
  const toCogs = total.minus(toStock);
  const today = istDate();
  const [app] = await tx.insert(landedCostApplications).values({
    shipmentId, appliedOn: today, total: money(total), toStock: money(toStock), toCogs: money(toCogs), createdBy: ctx.user?.id ?? null,
  }).returning();
  await tx.insert(landedCostAllocations).values(plan.allocations.map((a) => ({
    applicationId: app!.id, costLineId: a.costLineId, grnLineId: a.grnLineId, itemId: a.itemId,
    amount: money(a.amount), toStock: money(a.toStock), toCogs: money(a.toCogs),
  })));
  for (const i of plan.items) {
    await revalue(ctx, { itemId: i.item_id, value: i.to_stock, refType: 'landed_cost', refId: app!.id, reason: `Landed cost of import ${s.shipmentNo}` });
  }
  await tx.update(landedCostLines).set({ applicationId: app!.id, updatedAt: new Date() }).where(inArray(landedCostLines.id, plan.lines.map((l) => l.id)));
  await postJournal(ctx, {
    date: today, refType: 'landed_cost', refId: app!.id, entityId: s.entityId, narration: `Landed cost of import ${s.shipmentNo} put on the goods`,
    lines: [{ account: 'stock', debit: toStock }, { account: 'cogs', debit: toCogs }, { account: 'landed_cost_clearing', credit: total }],
  });
  await audit(ctx, 'import_shipment', shipmentId, 'apply_costs', null, { total: money(total), to_stock: money(toStock), to_cogs: money(toCogs) });
  return app!;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export async function shipmentDocument(tx: DB, id: string) {
  const [s] = await tx.select().from(importShipments).where(eq(importShipments.id, id));
  must(s, 'Import shipment');
  const [supplier] = await tx.select({ name: parties.name }).from(parties).where(eq(parties.id, s!.supplierId));
  const orders = await rows(tx, sql`
    select p.id, p.po_no, p.order_date, p.status, p.currency, p.fx_rate from import_shipment_orders o join purchase_orders p on p.id = o.purchase_order_id
     where o.shipment_id = ${id} order by p.po_no`);
  const costs = await rows(tx, sql`
    select c.*, a.name as paid_from, b.bill_no, b.supplier_invoice_no, p.name as billed_by, ap.applied_on
      from landed_cost_lines c left join accounts a on a.id = c.paid_from_account_id left join purchase_bills b on b.id = c.purchase_bill_id
      left join parties p on p.id = b.supplier_id left join landed_cost_applications ap on ap.id = c.application_id
     where c.shipment_id = ${id} order by c.created_at`);
  const goods = await goodsOf(tx, id);
  const applied = await rows<{ grn_line_id: string; amount: string }>(tx, sql`
    select a.grn_line_id, sum(a.amount)::text as amount from landed_cost_allocations a join landed_cost_applications ap on ap.id = a.application_id
     where ap.shipment_id = ${id} group by a.grn_line_id`);
  return {
    ...s!, supplier_name: supplier?.name, orders, costs,
    goods: goods.map((g) => {
      const landed = D(applied.find((a) => a.grn_line_id === g.grn_line_id)?.amount ?? 0);
      const cost = D(g.accepted).times(g.rate);
      return { ...g, cost: money(cost), landed: money(landed), landed_each: money(cost.plus(landed).div(g.accepted)) };
    }),
    applications: await rows(tx, sql`select * from landed_cost_applications where shipment_id = ${id} order by created_at`),
  };
}

export function importsRouter(db: DB) {
  const r = Router();
  const zStage = z.enum(IMPORT_STAGES);

  r.get('/', requirePerm('imports:read'), async (req, res) => {
    const q = zListQuery.extend({ stage: zStage.optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    sendList(req, res, await rows(db, sql`
      select s.id, s.shipment_no, s.stage, s.currency, s.bl_awb_no, s.boe_no, s.created_at, p.name as supplier_name,
             (select string_agg(po.po_no, ', ' order by po.po_no) from import_shipment_orders o join purchase_orders po on po.id = o.purchase_order_id where o.shipment_id = s.id) as orders,
             (select coalesce(sum(amount), 0) from landed_cost_lines c where c.shipment_id = s.id and c.kind <> 'igst') as costs,
             (select coalesce(sum(amount), 0) from landed_cost_lines c where c.shipment_id = s.id and c.kind <> 'igst' and c.application_id is null) as costs_open
        from import_shipments s join parties p on p.id = s.supplier_id
       where (${q.stage ?? null}::text is null or s.stage::text = ${q.stage ?? null})
         and (${like}::text is null or s.shipment_no ilike ${like} or p.name ilike ${like} or s.bl_awb_no ilike ${like} or s.boe_no ilike ${like})
       order by s.created_at desc limit ${q.limit} offset ${q.offset}`), 'import-shipments', { limit: q.limit });
  });

  /** Supplier advances: money paid out to suppliers and not yet set against a bill, by age (0-30, 31-90, over 90 days). */
  r.get('/advances', requirePerm('imports:read', 'payments:read'), async (req, res) => {
    sendList(req, res, await rows(db, sql`
      with open as (
        select p.party_id, p.paid_on, p.amount + p.tds_amount - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = p.id), 0) as unadjusted
          from payments p join parties s on s.id = p.party_id
         where p.direction = 'out' and p.status = 'posted' and s.party_type = 'supplier'
      )
      select s.id as party_id, s.name as supplier,
             sum(o.unadjusted) filter (where ${istDate()}::date - o.paid_on <= 30)::numeric(14,2) as days_0_30,
             sum(o.unadjusted) filter (where ${istDate()}::date - o.paid_on between 31 and 90)::numeric(14,2) as days_31_90,
             sum(o.unadjusted) filter (where ${istDate()}::date - o.paid_on > 90)::numeric(14,2) as over_90,
             sum(o.unadjusted)::numeric(14,2) as total
        from open o join parties s on s.id = o.party_id
       where o.unadjusted > 0 group by s.id, s.name order by total desc`), 'supplier-advances');
  });

  r.get('/:id', requirePerm('imports:read'), async (req, res) => {
    res.json({ data: await shipmentDocument(db, zId.parse(req.params.id)) });
  });

  r.post('/', requirePerm('imports:write'), async (req, res) => {
    const b = z.object({
      supplier_id: zId, purchase_order_ids: z.array(zId).max(50).prefault([]), currency: zCurrency, fx_rate: emptyToNull(zFxRate).optional(),
      bl_awb_no: emptyToNull(z.string().trim().max(60)).optional(), notes: emptyToNull(z.string().trim().max(2000)).optional(),
    }).parse(req.body);
    const s = await inTx(db, req, (ctx) => createShipment(ctx, {
      supplierId: b.supplier_id, purchaseOrderIds: b.purchase_order_ids, currency: b.currency, fxRate: b.fx_rate, blAwbNo: b.bl_awb_no, notes: b.notes,
    }));
    res.status(201).json({ data: s });
  });

  r.patch('/:id', requirePerm('imports:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      purchase_order_ids: z.array(zId).max(50).optional(), fx_rate: emptyToNull(zFxRate).optional(), bl_awb_no: emptyToNull(z.string().trim().max(60)).optional(),
      boe_no: emptyToNull(z.string().trim().max(30)).optional(), boe_date: emptyToNull(zDate).optional(), notes: emptyToNull(z.string().trim().max(2000)).optional(),
      documents: z.array(zId).max(50).optional(),
    }).parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const s = await lockShipment(ctx.tx, id);
      if (b.purchase_order_ids) {
        await checkOrders(ctx.tx, s.supplierId, b.purchase_order_ids, id);
        await ctx.tx.delete(importShipmentOrders).where(eq(importShipmentOrders.shipmentId, id));
        if (b.purchase_order_ids.length) await ctx.tx.insert(importShipmentOrders).values([...new Set(b.purchase_order_ids)].map((purchaseOrderId) => ({ shipmentId: id, purchaseOrderId })));
      }
      const patch: Partial<typeof importShipments.$inferInsert> = { updatedAt: new Date() };
      if (b.fx_rate !== undefined) patch.fxRate = b.fx_rate;
      if (b.bl_awb_no !== undefined) patch.blAwbNo = b.bl_awb_no;
      if (b.boe_no !== undefined) patch.boeNo = b.boe_no;
      if (b.boe_date !== undefined) patch.boeDate = b.boe_date;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.documents !== undefined) patch.documents = b.documents;
      const [row] = await ctx.tx.update(importShipments).set(patch).where(eq(importShipments.id, id)).returning();
      await audit(ctx, 'import_shipment', id, 'update', s, b);
      return row;
    });
    res.json({ data: updated });
  });

  r.post('/:id/stage', requirePerm('imports:write'), async (req, res) => {
    const b = z.object({ stage: zStage, on: emptyToNull(zDate).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => setStage(ctx, zId.parse(req.params.id), b.stage, b.on)) });
  });

  r.post('/:id/costs', requirePerm('imports:post'), async (req, res) => {
    const b = z.object({
      kind: z.enum(LANDED_COST_KINDS), amount: zMoneyPos, basis: z.enum(LANDED_COST_BASES).prefault('value'), description: emptyToNull(z.string().trim().max(300)).optional(),
      paid_from_account_id: zId, paid_on: emptyToNull(zDate).optional(),
    }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => addPaidCost(ctx, zId.parse(req.params.id), {
      kind: b.kind, amount: b.amount, basis: b.basis, description: b.description, paidFromAccountId: b.paid_from_account_id, paidOn: b.paid_on,
    })) });
  });

  r.patch('/:id/costs/:lineId', requirePerm('imports:post'), async (req, res) => {
    const b = z.object({ kind: z.enum(LANDED_COST_KINDS).optional(), basis: z.enum(LANDED_COST_BASES).optional() }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => changeCost(ctx, zId.parse(req.params.id), zId.parse(req.params.lineId), b)) });
  });

  r.delete('/:id/costs/:lineId', requirePerm('imports:post'), async (req, res) => {
    await inTx(db, req, (ctx) => removeCost(ctx, zId.parse(req.params.id), zId.parse(req.params.lineId)));
    res.json({ ok: true });
  });

  r.get('/:id/preview', requirePerm('imports:read'), async (req, res) => {
    const plan = await previewCosts(db, zId.parse(req.params.id));
    res.json({ data: { total: plan.total, items: plan.items } });
  });

  r.post('/:id/apply', requirePerm('imports:post'), async (req, res) => {
    res.json({ data: await inTx(db, req, (ctx) => applyCosts(ctx, zId.parse(req.params.id))) });
  });

  return r;
}
