import { eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, MOVEMENT_TYPES, istDate, money, qty as fmtQty, round2 } from '@radcore/shared';
import { audit, auditRead } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { lockItems, onHand, stockIn, stockOut, valuation } from '../core/stock';
import { cleanSerials, needsSerials, unitsBySerial, unitsIn, unitsMove, unitsOut } from '../core/units';
import { assertFree } from './reservations';
import { rows, type DB } from '../db/client';
import {
  items, locations, stockAdjustmentLines, stockAdjustments, stockMovements, stockTransferLines, stockTransfers,
} from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import {
  type Ctx, emptyToNull, inTx, sendList, sized, wantsFile, zDate, zId, zListQuery, zMoney, zQty, zQtyNonNeg, zSerials, zSignedQty, zText,
} from '../lib/http';

/**
 * Stock as the stores see it: what is on hand and where, what is running low, what it is worth,
 * every movement, moving stock between places, and correcting it (an adjustment, a physical count,
 * opening stock).
 *
 * A transfer changes where stock is, not what it is worth, so it posts nothing to the books.
 * A correction changes the value, so it waits for approval and then posts the difference: to Stock
 * Adjustment, or for opening stock to Opening Balance Equity.
 */

// ---------------------------------------------------------------------------
// Transfers between places
// ---------------------------------------------------------------------------
async function activeLocation(tx: DB, id: string) {
  const [loc] = await tx.select().from(locations).where(eq(locations.id, id));
  if (!loc || !loc.active) throw badRequest('Location not found');
  return loc;
}

/**
 * Transfer between locations (e.g. Stores -> Showroom). Two ledger rows at the same value,
 * so total stock value does not change and no journal entry is needed. A serialised item moves
 * named units, two rows for each.
 */
export async function createTransfer(
  ctx: Ctx,
  input: { fromLocationId: string; toLocationId: string; reason: string; lines: { itemId: string; qty: string; serials?: string[] | null }[] },
) {
  const { tx } = ctx;
  if (input.fromLocationId === input.toLocationId) throw badRequest('Pick two different locations');
  const from = await activeLocation(tx, input.fromLocationId);
  const to = await activeLocation(tx, input.toLocationId);
  if (from.type === 'job_work' || to.type === 'job_work') throw badRequest('Stock goes to and comes back from job workers on a job work challan, not by a transfer');
  if (input.lines.length === 0) throw badRequest('Add at least one item');
  const itemRows = await lockItems(tx, input.lines.map((l) => l.itemId));
  const byId = new Map(itemRows.map((i) => [i.id, i]));
  const { number } = await nextNumber(tx, 'stock_transfer', istDate());
  const [transfer] = await tx
    .insert(stockTransfers)
    .values({ transferNo: number, fromLocationId: from.id, toLocationId: to.id, reason: input.reason, createdBy: ctx.user?.id ?? null })
    .returning();
  for (const l of input.lines) {
    const item = byId.get(l.itemId)!;
    if (!item.isStockItem) throw badRequest(`${item.name} is a service and has no stock`);
    const q = D(l.qty);
    const available = await onHand(tx, item.id, from.id);
    // A transfer must move goods that are physically there: never allowed to go negative.
    if (available.lt(q)) throw conflict(`Only ${fmtQty(available)} of ${item.name} in ${from.name}`);
    // Nor stock held for an order.
    if (!needsSerials(item)) await assertFree(ctx, item, from.id, q, null);
    const v = await valuation(tx, item.id);
    const unitCost = v.qty.gt(0) ? round2(v.value.div(v.qty)) : D(item.purchaseCost);
    const value = round2(q.times(unitCost));
    const base = { itemId: item.id, unitCost: money(unitCost), movementType: 'transfer' as const, refType: 'stock_transfer', refId: transfer!.id, reason: input.reason, createdBy: ctx.user?.id ?? null };
    const serials = needsSerials(item) ? cleanSerials(item, q, l.serials) : null;
    if (serials) {
      const moved = await unitsMove(ctx, { item, fromLocationId: from.id, toLocationId: to.id, serials, refType: 'stock_transfer', refId: transfer!.id, reason: input.reason });
      const each = money(unitCost);
      await tx.insert(stockMovements).values(moved.flatMap((u) => [
        { ...base, locationId: from.id, qty: '-1', value: money(D(each).neg()), unitId: u.id, batchId: u.batchId },
        { ...base, locationId: to.id, qty: '1', value: each, unitId: u.id, batchId: u.batchId },
      ]));
    } else {
      await tx.insert(stockMovements).values([
        { ...base, locationId: from.id, qty: fmtQty(q.neg()), value: money(value.neg()) },
        { ...base, locationId: to.id, qty: fmtQty(q), value: money(value) },
      ]);
    }
    await tx.insert(stockTransferLines).values({ transferId: transfer!.id, itemId: item.id, qty: fmtQty(q), serials });
  }
  await audit(ctx, 'stock_transfer', transfer!.id, 'create', null, { ...transfer, lines: input.lines });
  return transfer!;
}

// ---------------------------------------------------------------------------
// Adjustments, counts and opening stock
// ---------------------------------------------------------------------------
type AdjLine = {
  itemId: string; qtyChange: string; unitCost?: string | null; systemQty?: string | null; countedQty?: string | null;
  /** A serialised item: the serials coming in (opening stock, found) or going out (written off), one per unit. */
  serials?: string[] | null;
};

/**
 * Adjustment / physical count / opening stock. Saved as Pending: nothing touches the stock
 * ledger until an admin (or the owner) approves it (PRD 7.6).
 */
export async function createAdjustment(
  ctx: Ctx,
  input: { kind: 'adjustment' | 'count' | 'opening'; locationId: string; reason: string; lines: AdjLine[] },
) {
  const { tx } = ctx;
  const where = await activeLocation(tx, input.locationId);
  if (where.type === 'job_work') throw badRequest('Stock that is with job workers is put right on its job work challan (record it as come back, used or lost)');
  if (input.lines.length === 0) throw badRequest('Add at least one item');
  const found = await tx.select().from(items).where(inArray(items.id, input.lines.map((l) => l.itemId)));
  const serials = new Map<AdjLine, string[] | null>();
  for (const l of input.lines) {
    const item = found.find((i) => i.id === l.itemId);
    if (!item) throw badRequest('Item not found');
    if (!needsSerials(item)) { serials.set(l, null); continue; }
    if (input.kind === 'count') throw badRequest(`${item.name} has serial numbers: put it right with an adjustment naming the serials, not a count`);
    const list = cleanSerials(item, D(l.qtyChange).abs(), l.serials);
    // Going out: the units must be here now (checked again when it is approved).
    if (D(l.qtyChange).lt(0)) {
      for (const u of await unitsBySerial(tx, item, list)) {
        if (u.locationId !== input.locationId) throw conflict(`${item.name} ${u.serialNo} is not at ${where.name}`);
      }
    }
    serials.set(l, list);
  }
  const { number } = await nextNumber(tx, 'stock_adjustment', istDate());
  const [adj] = await tx
    .insert(stockAdjustments)
    .values({ adjustmentNo: number, kind: input.kind, locationId: input.locationId, reason: input.reason, createdBy: ctx.user?.id ?? null })
    .returning();
  await tx.insert(stockAdjustmentLines).values(
    input.lines.map((l) => ({
      adjustmentId: adj!.id, itemId: l.itemId, qtyChange: fmtQty(l.qtyChange), unitCost: l.unitCost ? money(l.unitCost) : null,
      systemQty: l.systemQty ?? null, countedQty: l.countedQty ?? null, serials: serials.get(l) ?? null,
    })),
  );
  await audit(ctx, 'stock_adjustment', adj!.id, 'create', null, { ...adj, lines: input.lines });
  return adj!;
}

/** Approve or reject a pending adjustment. Approving is what moves the stock and posts the difference to the books. */
export async function decideAdjustment(ctx: Ctx, id: string, approve: boolean, note?: string | null) {
  const { tx } = ctx;
  const [adj] = await tx.select().from(stockAdjustments).where(eq(stockAdjustments.id, id)).for('update');
  must(adj, 'Stock adjustment');
  if (adj!.status !== 'pending') throw conflict(`This adjustment is already ${adj!.status}`);
  const status = approve ? 'approved' : 'rejected';
  if (approve) {
    const lines = await tx.select().from(stockAdjustmentLines).where(eq(stockAdjustmentLines.adjustmentId, id));
    const itemRows = await lockItems(tx, lines.map((l) => l.itemId));
    const byId = new Map(itemRows.map((i) => [i.id, i]));
    let gain = D(0);
    let loss = D(0);
    for (const l of lines) {
      const item = byId.get(l.itemId)!;
      if (!item.isStockItem) throw badRequest(`${item.name} is a service and has no stock`);
      const change = D(l.qtyChange);
      if (change.isZero()) continue;
      const movementType = adj!.kind === 'opening' ? 'opening' : 'adjustment';
      if (needsSerials(item) && !l.serials?.length) throw badRequest(`${item.name} now has serial numbers: raise this adjustment again with the serials`);
      if (change.gt(0)) {
        const v = await valuation(tx, item.id);
        const cost = l.unitCost ?? (v.qty.gt(0) ? money(v.value.div(v.qty)) : item.purchaseCost);
        gain = gain.plus(needsSerials(item)
          ? await unitsIn(ctx, {
              item, locationId: adj!.locationId, serials: l.serials!, unitCost: cost, movementType,
              refType: 'stock_adjustment', refId: id, event: adj!.kind === 'opening' ? 'opening' : 'found', reason: adj!.reason,
            })
          : await stockIn(ctx, {
              itemId: item.id, locationId: adj!.locationId, qty: change, unitCost: cost, movementType,
              refType: 'stock_adjustment', refId: id, reason: adj!.reason,
            }));
      } else if (needsSerials(item)) {
        // Written off, whatever state it was in: the unit is gone.
        const out = await unitsOut(ctx, {
          item, locationId: adj!.locationId, serials: l.serials!, movementType, refType: 'stock_adjustment', refId: id,
          event: 'written_off', status: 'scrapped', reason: adj!.reason,
          fromStatuses: ['available', 'demo', 'under_repair', 'quarantine', 'damaged'],
        });
        loss = loss.plus(out.value);
      } else {
        const out = await stockOut(ctx, {
          itemId: item.id, locationId: adj!.locationId, qty: change.neg(), movementType,
          refType: 'stock_adjustment', refId: id, reason: adj!.reason, itemName: item.name, fallbackCost: item.purchaseCost,
        });
        loss = loss.plus(out.value);
      }
    }
    // Opening stock is funded by Opening Balance Equity; gains/losses hit Stock Adjustment (P&L).
    const contra = adj!.kind === 'opening' ? 'opening_equity' : 'stock_adjustment';
    await postJournal(ctx, {
      date: istDate(), refType: 'stock_adjustment', refId: id,
      narration: `${adj!.kind === 'opening' ? 'Opening stock' : adj!.kind === 'count' ? 'Physical count' : 'Stock adjustment'} ${adj!.adjustmentNo}: ${adj!.reason}`,
      lines: [
        { account: 'stock', debit: gain },
        { account: contra, credit: gain },
        { account: contra, debit: loss },
        { account: 'stock', credit: loss },
      ],
    });
  }
  const [updated] = await tx
    .update(stockAdjustments)
    .set({ status, decidedBy: ctx.user?.id ?? null, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(stockAdjustments.id, id))
    .returning();
  await audit(ctx, 'stock_adjustment', id, status, { status: 'pending' }, { status, note: note ?? null });
  return updated!;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function inventoryRouter(db: DB) {
  const r = Router();

  /** Stock on hand per item and location - always sum(stock_movements), never a stored number. */
  r.get('/on-hand', requirePerm('stock:read'), async (req, res) => {
    const q = zListQuery.extend({
      location_id: zId.optional(), item_type: z.string().optional(), include_zero: z.enum(['true', 'false']).prefault('false'),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select i.id as item_id, i.sku, i.name, i.item_type, i.unit, i.reorder_level,
             coalesce(sum(s.qty) filter (where l.type = 'stores'), 0) as stores_qty,
             coalesce(sum(s.qty) filter (where l.type = 'showroom'), 0) as showroom_qty,
             coalesce(sum(s.qty) filter (where l.type = 'rejected'), 0) as rejected_qty,
             coalesce(sum(s.qty) filter (where l.type = 'job_work'), 0) as job_work_qty,
             -- demo units, the workshop, a franchisee's store, on the road: ours, but not on the shelf to sell
             coalesce(sum(s.qty) filter (where l.type in ('service_bay', 'demo', 'franchise', 'in_transit')), 0) as elsewhere_qty,
             -- held for orders (reservations), and what is left to sell: on the shelf less what is held
             coalesce(sum(s.reserved) filter (where l.type in ('stores', 'showroom')), 0) as reserved_qty,
             coalesce(sum(s.available) filter (where l.type in ('stores', 'showroom')), 0) as available_qty,
             coalesce(max(v.value), 0) as value, max(v.avg_cost) as avg_cost
        from items i
        left join v_stock_on_hand s on s.item_id = i.id
        left join locations l on l.id = s.location_id
        left join v_item_valuation v on v.item_id = i.id
       where i.is_stock_item and i.active
         and (${q.location_id ?? null}::uuid is null or s.location_id = ${q.location_id ?? null}::uuid)
         and (${q.item_type ?? null}::text is null or i.item_type::text = ${q.item_type ?? null})
         and (${like}::text is null or i.name ilike ${like} or i.sku ilike ${like})
       group by i.id
      having ${q.include_zero} = 'true' or coalesce(sum(s.qty), 0) <> 0
       order by i.name
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'stock-on-hand', { limit: q.limit });
  });

  /** Low stock: sellable on-hand below the reorder level (PRD 7.6). */
  r.get('/low', requirePerm('stock:read'), async (req, res) => {
    const data = await rows(db, sql`
      select i.id as item_id, i.sku, i.name, i.item_type, i.unit, i.reorder_level, coalesce(s.qty, 0) as available_qty,
             (i.reorder_level - coalesce(s.qty, 0)) as shortfall
        from items i
        left join (select m.item_id, sum(m.qty) as qty from stock_movements m join locations l on l.id = m.location_id
                    where l.type in ('stores', 'showroom') group by m.item_id) s on s.item_id = i.id
       where i.is_stock_item and i.active and i.reorder_level is not null and coalesce(s.qty, 0) < i.reorder_level
       order by (i.reorder_level - coalesce(s.qty, 0)) desc`);
    sendList(req, res, data, 'low-stock');
  });

  /** Stock summary and valuation (PRD 7.8 reports). The total equals the Stock in Hand ledger balance. */
  r.get('/valuation', requirePerm('costs:read'), auditRead(db, 'stock_valuation'), async (req, res) => {
    const data = await rows<{ value: string }>(db, sql`
      select i.id as item_id, i.sku, i.name, i.item_type, i.unit, v.qty, v.avg_cost, v.value
        from v_item_valuation v join items i on i.id = v.item_id
       where v.qty <> 0 or v.value <> 0 order by i.name`);
    if (wantsFile(req)) return sendList(req, res, data, 'stock-valuation');
    res.json({ data, total_value: money(data.reduce((a, d) => a.plus(d.value), D(0))) });
  });

  r.get('/movements', requirePerm('stock:read'), async (req, res) => {
    const q = zListQuery.extend({
      item_id: zId.optional(), location_id: zId.optional(), type: z.enum(MOVEMENT_TYPES).optional(),
      from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const data = await rows(db, sql`
      select m.id, m.posted_at, i.sku, i.name as item_name, l.name as location, m.qty, m.unit_cost, m.value, m.movement_type,
             m.ref_type, m.ref_id, m.reason, u.name as user_name
        from stock_movements m join items i on i.id = m.item_id join locations l on l.id = m.location_id
        left join users u on u.id = m.created_by
       where (${q.item_id ?? null}::uuid is null or m.item_id = ${q.item_id ?? null}::uuid)
         and (${q.location_id ?? null}::uuid is null or m.location_id = ${q.location_id ?? null}::uuid)
         and (${q.type ?? null}::text is null or m.movement_type::text = ${q.type ?? null})
         and (${q.from ?? null}::date is null or (m.posted_at at time zone 'Asia/Kolkata')::date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or (m.posted_at at time zone 'Asia/Kolkata')::date <= ${q.to ?? null}::date)
       order by m.id desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'stock-movements', { limit: q.limit });
  });

  r.post('/transfers', requirePerm('stock:write'), async (req, res) => {
    const b = z.object({
      from_location_id: zId, to_location_id: zId, reason: zText(300),
      lines: z.array(z.object({ item_id: zId, qty: zQty, serials: zSerials.optional() })).min(1).max(200),
    }).parse(req.body);
    const transfer = await inTx(db, req, (ctx) =>
      createTransfer(ctx, {
        fromLocationId: b.from_location_id, toLocationId: b.to_location_id, reason: b.reason,
        lines: b.lines.map((l) => ({ itemId: l.item_id, qty: l.qty, serials: l.serials })),
      }));
    res.status(201).json({ data: transfer });
  });

  r.get('/adjustments', requirePerm('stock:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query);
    const data = await rows(db, sql`
      select a.*, l.name as location, c.name as created_by_name, d.name as decided_by_name,
             (select count(*)::int from stock_adjustment_lines x where x.adjustment_id = a.id and x.qty_change <> 0) as line_count
        from stock_adjustments a join locations l on l.id = a.location_id
        left join users c on c.id = a.created_by left join users d on d.id = a.decided_by
       where (${q.status ?? null}::text is null or a.status::text = ${q.status ?? null})
       order by a.created_at desc limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'stock-adjustments', { limit: q.limit });
  });

  r.get('/adjustments/:id', requirePerm('stock:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [adj] = await rows(db, sql`
      select a.*, l.name as location from stock_adjustments a join locations l on l.id = a.location_id where a.id = ${id}`);
    must(adj, 'Stock adjustment');
    const lines = await rows(db, sql`
      select x.*, i.sku, i.name as item_name, i.unit from stock_adjustment_lines x join items i on i.id = x.item_id
       where x.adjustment_id = ${id} order by i.name`);
    res.json({ data: { ...adj, lines } });
  });

  /** Manual adjustment (damage, sample, found stock...) or opening stock. Needs a reason and approval. */
  r.post('/adjustments', requirePerm('stock:write'), async (req, res) => {
    const b = z.object({
      kind: z.enum(['adjustment', 'opening']).prefault('adjustment'),
      location_id: zId,
      reason: zText(300),
      lines: z.array(z.object({
        item_id: zId,
        qty_change: zSignedQty.refine(sized((d) => !d.isZero()), 'cannot be 0'),
        unit_cost: emptyToNull(zMoney).optional(),
        serials: zSerials.optional(),
      })).min(1).max(500),
    }).parse(req.body);
    if (b.kind === 'opening' && b.lines.some((l) => D(l.qty_change).lte(0) || !l.unit_cost)) {
      throw badRequest('Opening stock lines need a positive quantity and a unit cost');
    }
    const adj = await inTx(db, req, (ctx) =>
      createAdjustment(ctx, {
        kind: b.kind, locationId: b.location_id, reason: b.reason,
        lines: b.lines.map((l) => ({ itemId: l.item_id, qtyChange: l.qty_change, unitCost: l.unit_cost, serials: l.serials })),
      }));
    res.status(201).json({ data: adj });
  });

  /** Physical count: enter what was counted; the system works out the difference. */
  r.post('/counts', requirePerm('stock:write'), async (req, res) => {
    const b = z.object({
      location_id: zId, reason: zText(300),
      lines: z.array(z.object({ item_id: zId, counted_qty: zQtyNonNeg })).min(1).max(1000),
    }).parse(req.body);
    const adj = await inTx(db, req, async (ctx) => {
      await lockItems(ctx.tx, b.lines.map((l) => l.item_id));
      const lines: AdjLine[] = [];
      for (const l of b.lines) {
        const system = await onHand(ctx.tx, l.item_id, b.location_id);
        lines.push({
          itemId: l.item_id, systemQty: fmtQty(system), countedQty: l.counted_qty,
          qtyChange: fmtQty(D(l.counted_qty).minus(system)),
        });
      }
      return createAdjustment(ctx, { kind: 'count', locationId: b.location_id, reason: b.reason, lines });
    });
    res.status(201).json({ data: adj });
  });

  r.post('/adjustments/:id/approve', requirePerm('stock:approve'), async (req, res) => {
    const id = zId.parse(req.params.id);
    res.json({ data: await inTx(db, req, (ctx) => decideAdjustment(ctx, id, true)) });
  });

  r.post('/adjustments/:id/reject', requirePerm('stock:approve'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ note: emptyToNull(z.string().trim().max(500)).optional() }).parse(req.body ?? {});
    res.json({ data: await inTx(db, req, (ctx) => decideAdjustment(ctx, id, false, b.note)) });
  });
  return r;
}
