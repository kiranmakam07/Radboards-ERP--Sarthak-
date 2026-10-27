import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { D, Decimal, money, qty as fmtQty, round2, type MovementType, type Num } from '@radcore/shared';
import { rows } from '../db/client';
import type { DB } from '../db/client';
import { items, locations, stockMovements } from '../db/schema';
import { badRequest, conflict } from '../lib/errors';
import type { Ctx } from '../lib/http';
import { getSetting } from './settings';

/**
 * The stock ledger. Stock on hand is never stored: it is the sum of stock_movements, one row for
 * every time stock came in, went out or changed place.
 *
 * Valuation is a moving average per item, across all places together. Stock coming in carries its
 * own cost (stockIn); stock going out takes the average at that moment (stockOut). The module that
 * moves the stock posts the same value to the Stock in Hand account, which is why the stock report
 * and the balance sheet agree (checked by GET /api/accounting/reports/integrity).
 *
 * Two modules write movement rows themselves, because they must carry an exact value across rather
 * than re-price it: a transfer between places (modules/inventory.ts) and what comes back from job
 * work (modules/jobwork.ts). Everything else goes through stockIn and stockOut.
 *
 * The order is always: lock the items (lockItems), then read, then move.
 */

/**
 * Serialise every stock change per item: lock the item rows (in id order, so two
 * transactions can never deadlock) before reading stock on hand or valuation.
 */
export async function lockItems(tx: DB, itemIds: string[]) {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return [];
  const found = await tx.select().from(items).where(inArray(items.id, ids)).orderBy(asc(items.id)).for('update');
  if (found.length !== ids.length) throw badRequest('One or more items do not exist');
  return found;
}

/** How much of an item is in one place right now. */
export async function onHand(tx: DB, itemId: string, locationId: string): Promise<Decimal> {
  const [r] = await rows<{ qty: string | null }>(tx, sql`
    select coalesce(sum(qty), 0)::text as qty from stock_movements
     where item_id = ${itemId} and location_id = ${locationId}`);
  return D(r?.qty ?? 0);
}

/** Item-level moving-average valuation across all locations. */
export async function valuation(tx: DB, itemId: string): Promise<{ qty: Decimal; value: Decimal }> {
  const [r] = await rows<{ qty: string; value: string }>(tx, sql`
    select coalesce(sum(qty), 0)::text as qty, coalesce(sum(value), 0)::text as value
      from stock_movements where item_id = ${itemId}`);
  return { qty: D(r?.qty ?? 0), value: D(r?.value ?? 0) };
}

/** The place of a given kind that documents use when none is named: the oldest active one. */
export async function locationByType(tx: DB, type: 'stores' | 'showroom' | 'rejected' | 'job_work'): Promise<string> {
  const [loc] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.type, type), eq(locations.active, true)))
    .orderBy(asc(locations.createdAt))
    .limit(1);
  if (!loc) throw badRequest(`No active "${type}" location is set up`);
  return loc.id;
}

/**
 * Stock lying with job workers is moved only by a job work challan and what is recorded against it,
 * so the challans and the stock can never disagree. A sale, a transfer or a count cannot touch it.
 */
export async function assertNotWithJobWorkers(tx: DB, locationId: string, refType: string): Promise<void> {
  if (refType.startsWith('job_work')) return;
  const [loc] = await tx.select({ type: locations.type }).from(locations).where(eq(locations.id, locationId));
  if (loc?.type === 'job_work') throw badRequest('Stock that is with job workers moves only on a job work challan');
}

type MoveBase = {
  itemId: string;
  locationId: string;
  qty: Num;
  movementType: MovementType;
  refType: string;
  refId: string;
  reason?: string | null;
  /** A serialised item moves one unit per row (core/units.ts). */
  unitId?: string | null;
  batchId?: string | null;
};

/** Stock in at a known unit cost. Returns the value added (what the GL should debit). */
export async function stockIn(ctx: Ctx, m: MoveBase & { unitCost: Num }): Promise<Decimal> {
  const q = D(m.qty);
  if (q.lte(0)) throw badRequest('Stock-in quantity must be more than 0');
  await assertNotWithJobWorkers(ctx.tx, m.locationId, m.refType);
  const value = round2(q.times(D(m.unitCost)));
  await ctx.tx.insert(stockMovements).values({
    itemId: m.itemId,
    locationId: m.locationId,
    qty: fmtQty(q),
    unitCost: money(m.unitCost),
    value: money(value),
    movementType: m.movementType,
    refType: m.refType,
    refId: m.refId,
    reason: m.reason ?? null,
    unitId: m.unitId ?? null,
    batchId: m.batchId ?? null,
    createdBy: ctx.user?.id ?? null,
  });
  return value;
}

/**
 * A change of value with no change of quantity: cost found after the goods came in (an import's freight and
 * duty, modules/imports.ts). One row of quantity 0 carrying the value, at the place holding most of the item,
 * so the item's moving-average cost rises for every unit held. The caller posts the same value to Stock in Hand.
 */
export async function revalue(ctx: Ctx, m: { itemId: string; value: Num; refType: string; refId: string; reason?: string | null }): Promise<Decimal> {
  const value = round2(m.value);
  if (value.isZero()) return value;
  const [most] = await rows<{ location_id: string }>(ctx.tx, sql`
    select location_id from stock_movements where item_id = ${m.itemId} group by location_id having sum(qty) > 0 order by sum(qty) desc limit 1`);
  const locationId = most?.location_id ?? (await locationByType(ctx.tx, 'stores'));
  await ctx.tx.insert(stockMovements).values({
    itemId: m.itemId, locationId, qty: '0', unitCost: '0', value: money(value), movementType: 'revaluation',
    refType: m.refType, refId: m.refId, reason: m.reason ?? null, createdBy: ctx.user?.id ?? null,
  });
  return value;
}

/**
 * Stock out at the moving-average rate (or at a specific cost, e.g. a supplier return at
 * the PO rate). Blocks negative stock unless the admin setting allows it (PRD 8.5).
 * The caller must already hold the item lock (lockItems).
 * Returns the cost removed (what the GL should credit Stock with).
 */
export async function stockOut(
  ctx: Ctx,
  m: MoveBase & { unitCostOverride?: Num; itemName?: string; fallbackCost?: Num },
): Promise<{ unitCost: Decimal; value: Decimal }> {
  const { tx } = ctx;
  const q = D(m.qty);
  if (q.lte(0)) throw badRequest('Stock-out quantity must be more than 0');
  await assertNotWithJobWorkers(tx, m.locationId, m.refType);

  const available = await onHand(tx, m.itemId, m.locationId);
  if (available.lt(q)) {
    const allowNegative = await getSetting(tx, 'allow_negative_stock');
    if (!allowNegative) {
      throw conflict(
        `Not enough stock${m.itemName ? ` of ${m.itemName}` : ''}: ${fmtQty(available)} on hand, ${fmtQty(q)} needed`,
        { itemId: m.itemId, locationId: m.locationId, available: fmtQty(available), needed: fmtQty(q) },
      );
    }
  }

  let unitCost: Decimal;
  let value: Decimal;
  if (m.unitCostOverride !== undefined) {
    unitCost = round2(m.unitCostOverride);
    value = round2(q.times(unitCost));
  } else {
    const v = await valuation(tx, m.itemId);
    // Stock on hand goes out at its average, even when that is nothing (stock brought in at no cost): taking
    // the purchase price instead would leave the stock's value below zero (code review, 27 Oct 2026).
    if (v.qty.gt(0)) {
      unitCost = round2(v.value.div(v.qty));
      // Selling the last units takes ALL remaining value, so rounding paise never get stranded.
      value = q.eq(v.qty) ? v.value : round2(q.times(v.value).div(v.qty));
    } else {
      unitCost = round2(m.fallbackCost ?? 0);
      value = round2(q.times(unitCost));
    }
  }

  await tx.insert(stockMovements).values({
    itemId: m.itemId,
    locationId: m.locationId,
    qty: fmtQty(q.neg()),
    unitCost: money(unitCost),
    value: money(value.neg()),
    movementType: m.movementType,
    refType: m.refType,
    refId: m.refId,
    reason: m.reason ?? null,
    unitId: m.unitId ?? null,
    batchId: m.batchId ?? null,
    createdBy: ctx.user?.id ?? null,
  });
  return { unitCost, value };
}
