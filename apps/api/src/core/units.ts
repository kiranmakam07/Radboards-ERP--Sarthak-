import { and, eq, inArray, sql } from 'drizzle-orm';
import { D, Decimal, SELLABLE_UNIT_STATUSES, type MovementType, type Num, type UnitStatus } from '@radcore/shared';
import { rows, type DB } from '../db/client';
import { batches, items, locations, unitEvents, units } from '../db/schema';
import { badRequest, conflict } from '../lib/errors';
import type { Ctx } from '../lib/http';
import { stockIn, stockOut } from './stock';

/**
 * Serialised units: a vehicle, a battery pack, a motor, each with its own serial.
 *
 * For an item marked is_serialised, every stock movement in or out of a place names the one unit it
 * moves (one ledger row per unit, quantity 1), so the count of units at a place always equals the
 * stock there. The one exception is the Rejected place: goods QC turned away are not given serials,
 * they go back to the supplier as a quantity. The quantity ledger stays the source of truth for
 * value; the units table is where each one is and what state it is in, and unit_events its history.
 *
 *   unitsIn     new units arrive (goods receipt QC, opening stock, stock found) or sold ones come back
 *   unitsOut    named units leave a place (a sale, a write-off)
 *   unitsMove   named units change place at the value they carry (a transfer)
 *
 * Every function expects the caller to hold the item lock (lockItems), like stockIn and stockOut.
 */

export type Unit = typeof units.$inferSelect;
type Item = typeof items.$inferSelect;

/**
 * The serials typed for a line: trimmed and upper-cased, one per unit, none twice. A serialised
 * item moves in whole units, so the quantity must be a whole number and match the serials.
 */
export function cleanSerials(item: Pick<Item, 'name'>, qty: Num, list: string[] | null | undefined): string[] {
  const q = D(qty);
  if (!q.isInteger()) throw badRequest(`${item.name} has serial numbers, so it moves in whole units (not ${q.toString()})`);
  const serials = (list ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (serials.length !== q.toNumber()) {
    throw badRequest(`${item.name} has serial numbers: give one serial for each of the ${q.toString()} (${serials.length} given)`);
  }
  const twice = serials.find((s, i) => serials.indexOf(s) !== i);
  if (twice) throw badRequest(`Serial ${twice} of ${item.name} is listed twice`);
  return serials;
}

/** The status a unit takes on arriving at a place: demo units are demo, the workshop holds units under repair. */
async function statusAt(tx: DB, locationId: string): Promise<UnitStatus> {
  const [loc] = await tx.select({ type: locations.type }).from(locations).where(eq(locations.id, locationId));
  if (loc?.type === 'demo') return 'demo';
  if (loc?.type === 'service_bay') return 'under_repair';
  if (loc?.type === 'rejected') return 'quarantine';
  return 'available';
}

/**
 * Units fitted inside another (a battery pack in a vehicle) have no place of their own: they go
 * where it goes. When the parent's status changes, every unit inside it takes the same status.
 */
async function cascadeStatus(ctx: Ctx, parentId: string, status: UnitStatus, refType: string, refId: string, soldOn?: string | null) {
  const inside = await rows<{ id: string; status: UnitStatus }>(ctx.tx, sql`
    with recursive down as (
      select id, status, 1 as depth from units where parent_unit_id = ${parentId}
      union all
      select c.id, c.status, down.depth + 1 from units c join down on c.parent_unit_id = down.id where down.depth < 20
    )
    select id, status from down`);
  for (const u of inside) {
    if (u.status === status) continue;
    await ctx.tx.update(units).set({ status, ...(status === 'sold' ? { soldOn: soldOn ?? null } : {}), updatedAt: new Date() }).where(eq(units.id, u.id));
    await unitEvent(ctx, { unitId: u.id, event: 'with_parent', from: { locationId: null, status: u.status }, to: { locationId: null, status }, refType, refId });
  }
}

/** Record one event in a unit's history. */
export async function unitEvent(
  ctx: Ctx,
  e: { unitId: string; event: string; from?: { locationId: string | null; status: UnitStatus | null }; to?: { locationId: string | null; status: UnitStatus | null };
    refType?: string | null; refId?: string | null; note?: string | null },
) {
  await ctx.tx.insert(unitEvents).values({
    unitId: e.unitId, event: e.event, fromLocationId: e.from?.locationId ?? null, fromStatus: e.from?.status ?? null,
    toLocationId: e.to?.locationId ?? null, toStatus: e.to?.status ?? null, refType: e.refType ?? null, refId: e.refId ?? null,
    note: e.note ?? null, createdBy: ctx.user?.id ?? null,
  });
}

/** The units of an item with these serials, all of them or an error naming the first one missing. */
export async function unitsBySerial(tx: DB, item: Pick<Item, 'id' | 'name'>, serials: string[]): Promise<Unit[]> {
  if (serials.length === 0) return [];
  const found = await tx.select().from(units).where(and(eq(units.itemId, item.id), inArray(units.serialNo, serials))).for('update');
  const missing = serials.find((s) => !found.some((u) => u.serialNo === s));
  if (missing) throw badRequest(`There is no ${item.name} with serial ${missing}`);
  return serials.map((s) => found.find((u) => u.serialNo === s)!);
}

/**
 * Units coming into a place, one ledger row each at the given cost. A serial seen before is accepted
 * only if that unit has left us (sold, returned, scrapped), as when a sold unit comes back; one that
 * is still in stock somewhere is refused. Returns the value added (what the GL should debit).
 */
export async function unitsIn(
  ctx: Ctx,
  m: {
    item: Item; locationId: string; serials: string[]; unitCost: Num; movementType: MovementType; refType: string; refId: string;
    event: string; reason?: string | null; batchId?: string | null; mfgDate?: string | null;
    /** A return: the units must be ones we sold. */
    returning?: boolean;
  },
): Promise<Decimal> {
  const { tx } = ctx;
  const status = await statusAt(tx, m.locationId);
  const existing = m.serials.length
    ? await tx.select().from(units).where(and(eq(units.itemId, m.item.id), inArray(units.serialNo, m.serials))).for('update')
    : [];
  let value = D(0);
  for (const serial of m.serials) {
    let unit = existing.find((u) => u.serialNo === serial);
    const before = unit ? { locationId: unit.locationId, status: unit.status } : undefined;
    if (m.returning && unit?.status !== 'sold') throw conflict(`${m.item.name} ${serial} was not sold, so it cannot come back on a return`);
    if (unit) {
      if (unit.locationId !== null || !['sold', 'rtv', 'scrapped'].includes(unit.status)) {
        throw conflict(`${m.item.name} ${serial} is already in stock (${unit.status.replace('_', ' ')})`);
      }
      [unit] = await tx.update(units).set({ status, locationId: m.locationId, updatedAt: new Date() }).where(eq(units.id, unit.id)).returning();
    } else {
      [unit] = await tx.insert(units).values({
        itemId: m.item.id, serialNo: serial, status, locationId: m.locationId, batchId: m.batchId ?? null, mfgDate: m.mfgDate ?? null,
        createdBy: ctx.user?.id ?? null,
      }).returning();
    }
    value = value.plus(await stockIn(ctx, {
      itemId: m.item.id, locationId: m.locationId, qty: 1, unitCost: m.unitCost, movementType: m.movementType,
      refType: m.refType, refId: m.refId, reason: m.reason, unitId: unit!.id, batchId: unit!.batchId,
    }));
    await unitEvent(ctx, { unitId: unit!.id, event: m.event, from: before, to: { locationId: m.locationId, status }, refType: m.refType, refId: m.refId, note: m.reason });
    await cascadeStatus(ctx, unit!.id, status, m.refType, m.refId);
  }
  return value;
}

/**
 * Named units leaving a place, one ledger row each at the moving-average cost. Each must be at that
 * place in a state it can leave from (sellable, unless `fromStatuses` says otherwise). Returns the
 * cost removed and the units, now in their new status.
 */
export async function unitsOut(
  ctx: Ctx,
  m: {
    item: Item; locationId: string; serials: string[]; movementType: MovementType; refType: string; refId: string;
    event: string; status: UnitStatus; reason?: string | null; soldOn?: string | null; fromStatuses?: readonly UnitStatus[];
  },
): Promise<{ value: Decimal; units: Unit[] }> {
  const { tx } = ctx;
  const found = await unitsBySerial(tx, m.item, m.serials);
  const allowed: readonly UnitStatus[] = m.fromStatuses ?? SELLABLE_UNIT_STATUSES;
  let value = D(0);
  const out: Unit[] = [];
  for (const unit of found) {
    if (unit.locationId !== m.locationId) throw conflict(`${m.item.name} ${unit.serialNo} is not at this place`);
    if (!allowed.includes(unit.status)) throw conflict(`${m.item.name} ${unit.serialNo} is ${unit.status.replace('_', ' ')} and cannot go out`);
    const moved = await stockOut(ctx, {
      itemId: m.item.id, locationId: m.locationId, qty: 1, movementType: m.movementType, refType: m.refType, refId: m.refId,
      reason: m.reason, itemName: m.item.name, fallbackCost: m.item.purchaseCost, unitId: unit.id, batchId: unit.batchId,
    });
    value = value.plus(moved.value);
    const [after] = await tx.update(units).set({
      status: m.status, locationId: null, ...(m.status === 'sold' ? { soldOn: m.soldOn ?? null } : {}), updatedAt: new Date(),
    }).where(eq(units.id, unit.id)).returning();
    await unitEvent(ctx, { unitId: unit.id, event: m.event, from: { locationId: unit.locationId, status: unit.status }, to: { locationId: null, status: m.status }, refType: m.refType, refId: m.refId, note: m.reason });
    await cascadeStatus(ctx, unit.id, m.status, m.refType, m.refId, m.soldOn);
    out.push(after!);
  }
  return { value, units: out };
}

/**
 * Named units changing place (a transfer). The caller writes the paired ledger rows at the value the
 * stock carries; this checks each unit is there and free to move, and moves it.
 */
export async function unitsMove(
  ctx: Ctx,
  m: { item: Item; fromLocationId: string; toLocationId: string; serials: string[]; refType: string; refId: string; reason?: string | null },
): Promise<Unit[]> {
  const { tx } = ctx;
  const found = await unitsBySerial(tx, m.item, m.serials);
  const status = await statusAt(tx, m.toLocationId);
  const moved: Unit[] = [];
  for (const unit of found) {
    if (unit.locationId !== m.fromLocationId) throw conflict(`${m.item.name} ${unit.serialNo} is not at the place it is being moved from`);
    if (unit.status === 'reserved') throw conflict(`${m.item.name} ${unit.serialNo} is reserved for an order`);
    if (unit.parentUnitId) throw conflict(`${m.item.name} ${unit.serialNo} is fitted in another unit; it moves with it`);
    const [after] = await tx.update(units).set({ status, locationId: m.toLocationId, updatedAt: new Date() }).where(eq(units.id, unit.id)).returning();
    await unitEvent(ctx, { unitId: unit.id, event: 'moved', from: { locationId: unit.locationId, status: unit.status }, to: { locationId: m.toLocationId, status }, refType: m.refType, refId: m.refId, note: m.reason });
    await cascadeStatus(ctx, unit.id, status, m.refType, m.refId);
    moved.push(after!);
  }
  return moved;
}

/** Find or make a batch of an item by its number (from the goods receipt). */
export async function batchFor(
  ctx: Ctx,
  itemId: string,
  b: { batchNo: string; mfgDate?: string | null; chemistry?: string | null; weightKg?: string | null; supplierId?: string | null },
): Promise<string> {
  const batchNo = b.batchNo.trim().toUpperCase();
  const [found] = await ctx.tx.select().from(batches).where(and(eq(batches.itemId, itemId), eq(batches.batchNo, batchNo)));
  if (found) return found.id;
  const [made] = await ctx.tx.insert(batches).values({
    itemId, batchNo, mfgDate: b.mfgDate ?? null, chemistry: b.chemistry ?? null, weightKg: b.weightKg ?? null, supplierId: b.supplierId ?? null,
    createdBy: ctx.user?.id ?? null,
  }).returning();
  return made!.id;
}

/** Serialised stock must be moved by serial: the quantity on the line is checked against the serials. */
export function needsSerials(item: Pick<Item, 'isSerialised' | 'isStockItem'>): boolean {
  return item.isSerialised && item.isStockItem;
}

/**
 * A unit and everything it sits in and everything fitted inside it, as far as it goes:
 * vehicle -> battery pack -> controller -> motor. `ancestors` runs from its direct parent to the top.
 */
export async function genealogy(tx: DB, unitId: string) {
  const ancestors = await rows(tx, sql`
    with recursive up as (
      select u.*, 1 as depth from units u where u.id = (select parent_unit_id from units where id = ${unitId})
      union all
      select p.*, up.depth + 1 from units p join up on p.id = up.parent_unit_id where up.depth < 20
    )
    select up.id, up.serial_no, up.status, up.depth, i.name as item_name, i.sku from up join items i on i.id = up.item_id order by up.depth`);
  const descendants = await rows(tx, sql`
    with recursive down as (
      select u.*, 1 as depth from units u where u.parent_unit_id = ${unitId}
      union all
      select c.*, down.depth + 1 from units c join down on c.parent_unit_id = down.id where down.depth < 20
    )
    select down.id, down.parent_unit_id, down.serial_no, down.status, down.depth, down.bpan, down.firmware_version,
           i.name as item_name, i.sku from down join items i on i.id = down.item_id order by down.depth, i.name, down.serial_no`);
  return { ancestors, descendants };
}
