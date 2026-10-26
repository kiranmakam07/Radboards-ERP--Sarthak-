import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, Decimal, istDate, qty as fmtQty } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { getSetting } from '../core/settings';
import { locationByType, lockItems, onHand } from '../core/stock';
import { cleanSerials, needsSerials, unitEvent, unitsBySerial } from '../core/units';
import { rows, type DB } from '../db/client';
import { locations, salesOrderLines, salesOrders, stockReservations, units } from '../db/schema';
import { assertOnce, badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zQty, zSerials, zText, type Ctx } from '../lib/http';

/**
 * Reservations: stock held for one sales order (a booking), so nobody sells it to someone else.
 * A quantity is held at a place, or a unit by its serial (the unit is then 'reserved'). Available
 * stock is on hand less the open reservations (v_stock_on_hand.available). Delivering the order
 * fulfils its reservations; cancelling it lets them go; one past its expiry date lets go by itself
 * the next time stock is reserved or delivered.
 */

export type Reservation = typeof stockReservations.$inferSelect;

/** Reservations past their date let their stock go, and a reserved unit goes back on the shelf. */
export async function expireReservations(ctx: Ctx): Promise<void> {
  const gone = await ctx.tx.update(stockReservations).set({ status: 'expired', closedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(stockReservations.status, 'open'), sql`${stockReservations.expiresOn} < ${istDate()}::date`)).returning();
  await freeUnits(ctx, gone, 'reservation_expired');
}

/** Units that were held by these reservations are available again (unless something else has happened to them). */
async function freeUnits(ctx: Ctx, closed: Reservation[], event: string) {
  for (const r of closed.filter((x) => x.unitId)) {
    const [u] = await ctx.tx.update(units).set({ status: 'available', updatedAt: new Date() })
      .where(and(eq(units.id, r.unitId!), eq(units.status, 'reserved'))).returning();
    if (u) await unitEvent(ctx, { unitId: u.id, event, from: { locationId: u.locationId, status: 'reserved' }, to: { locationId: u.locationId, status: 'available' }, refType: 'sales_order', refId: r.salesOrderId });
  }
}

/** How much of an item is held at a place by open reservations, leaving out one order's own. */
export async function reservedAt(tx: DB, itemId: string, locationId: string, exceptOrderId: string | null = null): Promise<Decimal> {
  const [r] = await rows<{ q: string }>(tx, sql`
    select coalesce(sum(qty), 0)::text as q from stock_reservations
     where item_id = ${itemId} and location_id = ${locationId} and status = 'open'
       and (expires_on is null or expires_on >= ${istDate()}::date)
       and (${exceptOrderId}::uuid is null or sales_order_id <> ${exceptOrderId}::uuid)`);
  return D(r?.q ?? 0);
}

/**
 * Stock about to leave a place for an order (or for no order: a transfer) must not be stock held for
 * another order. Unless negative stock is allowed, this refuses with how much is held.
 */
export async function assertFree(ctx: Ctx, item: { id: string; name: string }, locationId: string, qty: Decimal, orderId: string | null) {
  const held = await reservedAt(ctx.tx, item.id, locationId, orderId);
  if (held.isZero()) return;
  const here = await onHand(ctx.tx, item.id, locationId);
  if (qty.gt(here.minus(held)) && !(await getSetting(ctx.tx, 'allow_negative_stock'))) {
    throw conflict(`Only ${fmtQty(Decimal.max(here.minus(held), 0))} of ${item.name} is free here: ${fmtQty(held)} is reserved for other orders`);
  }
}

/** Hold stock for an order: quantities at a place, or named units for an item kept by serial. */
export async function reserve(
  ctx: Ctx,
  orderId: string,
  input: { lines: { orderLineId: string; qty: string; locationId?: string | null; serials?: string[] | null }[]; expiresOn?: string | null },
): Promise<Reservation[]> {
  const { tx } = ctx;
  await expireReservations(ctx);
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for('update');
  must(order, 'Sales order');
  if (!['draft', 'confirmed'].includes(order!.status)) throw conflict(`Order ${order!.orderNo} is ${order!.status}; stock is reserved for an order not yet delivered`);
  if (input.expiresOn && input.expiresOn < istDate()) throw badRequest('The hold cannot end before today');
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId));
  assertOnce(input.lines, (l) => l.orderLineId, 'order line');
  const itemRows = await lockItems(tx, input.lines.map((l) => lines.find((x) => x.id === l.orderLineId)?.itemId ?? '').filter(Boolean));
  const made: Reservation[] = [];
  for (const l of input.lines) {
    const line = lines.find((x) => x.id === l.orderLineId);
    if (!line) throw badRequest('Line does not belong to this order');
    const item = itemRows.find((i) => i.id === line.itemId)!;
    if (!item.isStockItem) throw badRequest(`${item.name} is a service: there is no stock to hold`);
    const q = D(l.qty);
    const locationId = l.locationId ?? (await locationByType(tx, order!.channel === 'store' ? 'showroom' : 'stores'));
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
    if (!loc?.active || !['stores', 'showroom', 'demo', 'franchise'].includes(loc.type)) throw badRequest('Stock can be held only at a place it is sold from');
    // Never more than the order still has to deliver.
    const [held] = await rows<{ q: string }>(tx, sql`
      select coalesce(sum(qty), 0)::text as q from stock_reservations where sales_order_line_id = ${line.id} and status = 'open'`);
    if (q.plus(held?.q ?? 0).gt(D(line.qty).minus(line.deliveredQty))) throw conflict(`That would hold more ${item.name} than the order still needs`);

    if (needsSerials(item)) {
      const serials = cleanSerials(item, q, l.serials);
      for (const u of await unitsBySerial(tx, item, serials)) {
        if (u.locationId !== locationId) throw conflict(`${item.name} ${u.serialNo} is not at ${loc.name}`);
        if (!['available', 'demo'].includes(u.status)) throw conflict(`${item.name} ${u.serialNo} is ${u.status.replace('_', ' ')} and cannot be held`);
        const [r] = await tx.insert(stockReservations).values({
          itemId: item.id, locationId, unitId: u.id, qty: '1', salesOrderId: orderId, salesOrderLineId: line.id, expiresOn: input.expiresOn ?? null, createdBy: ctx.user?.id ?? null,
        }).returning();
        await tx.update(units).set({ status: 'reserved', updatedAt: new Date() }).where(eq(units.id, u.id));
        await unitEvent(ctx, { unitId: u.id, event: 'reserved', from: { locationId, status: u.status }, to: { locationId, status: 'reserved' }, refType: 'sales_order', refId: orderId, note: `For ${order!.orderNo}` });
        made.push(r!);
      }
    } else {
      const free = (await onHand(tx, item.id, locationId)).minus(await reservedAt(tx, item.id, locationId));
      if (q.gt(free)) throw conflict(`Only ${fmtQty(Decimal.max(free, 0))} of ${item.name} is free at ${loc.name} to hold`);
      const [r] = await tx.insert(stockReservations).values({
        itemId: item.id, locationId, qty: fmtQty(q), salesOrderId: orderId, salesOrderLineId: line.id, expiresOn: input.expiresOn ?? null, createdBy: ctx.user?.id ?? null,
      }).returning();
      made.push(r!);
    }
  }
  await audit(ctx, 'sales_order', orderId, 'reserve', null, made);
  return made;
}

/** Let go of one reservation, or of all an order's open ones (the order was cancelled). */
export async function release(ctx: Ctx, where: { id?: string; orderId?: string }, reason: string): Promise<Reservation[]> {
  const cond = where.id ? eq(stockReservations.id, where.id) : eq(stockReservations.salesOrderId, where.orderId!);
  const closed = await ctx.tx.update(stockReservations).set({ status: 'released', closedAt: new Date(), updatedAt: new Date() })
    .where(and(cond, eq(stockReservations.status, 'open'))).returning();
  await freeUnits(ctx, closed, 'reservation_released');
  if (closed.length) await audit(ctx, 'sales_order', closed[0]!.salesOrderId, 'release_reservation', null, { reservations: closed.map((r) => r.id), reason });
  return closed;
}

/**
 * An order's delivery uses up what was held for it: named units delivered close their reservation;
 * a quantity delivered is taken off the open quantity reservations of that line, oldest first.
 */
export async function fulfil(ctx: Ctx, orderLineId: string, locationId: string, qty: Decimal, unitIds: string[]): Promise<void> {
  const { tx } = ctx;
  if (unitIds.length) {
    await tx.update(stockReservations).set({ status: 'fulfilled', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(stockReservations.status, 'open'), inArray(stockReservations.unitId, unitIds)));
    return;
  }
  let left = qty;
  const open = await tx.select().from(stockReservations)
    .where(and(eq(stockReservations.salesOrderLineId, orderLineId), eq(stockReservations.locationId, locationId), eq(stockReservations.status, 'open')))
    .orderBy(asc(stockReservations.createdAt)).for('update');
  for (const r of open) {
    if (left.lte(0)) break;
    if (left.gte(r.qty)) {
      await tx.update(stockReservations).set({ status: 'fulfilled', closedAt: new Date(), updatedAt: new Date() }).where(eq(stockReservations.id, r.id));
      left = left.minus(r.qty);
    } else {
      await tx.update(stockReservations).set({ qty: fmtQty(D(r.qty).minus(left)), updatedAt: new Date() }).where(eq(stockReservations.id, r.id));
      left = D(0);
    }
  }
}

/** The reservations of one order, newest first, for the order page. */
export function reservationsOf(db: DB, orderId: string) {
  return rows(db, sql`
    select r.id, r.status, r.qty, r.expires_on, r.created_at, r.closed_at, r.sales_order_line_id, i.name as item_name, i.sku, l.name as location,
           u.serial_no
      from stock_reservations r join items i on i.id = r.item_id join locations l on l.id = r.location_id left join units u on u.id = r.unit_id
     where r.sales_order_id = ${orderId} order by r.created_at desc`);
}

export function reservationsRouter(db: DB) {
  const r = Router();

  /** Hold stock for an order (a booking). */
  r.post('/orders/:id/reservations', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      lines: z.array(z.object({ order_line_id: zId, qty: zQty, location_id: emptyToNull(zId).optional(), serials: zSerials.optional() })).min(1).max(200),
      expires_on: emptyToNull(zDate).optional(),
    }).parse(req.body);
    const made = await inTx(db, req, (ctx) => reserve(ctx, id, {
      lines: b.lines.map((l) => ({ orderLineId: l.order_line_id, qty: l.qty, locationId: l.location_id, serials: l.serials })), expiresOn: b.expires_on,
    }));
    res.status(201).json({ data: made });
  });

  r.post('/reservations/:id/release', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(300).default('Let go') }).parse(req.body ?? {});
    const closed = await inTx(db, req, (ctx) => release(ctx, { id }, b.reason));
    if (closed.length === 0) throw conflict('This reservation is not open');
    res.json({ data: closed[0] });
  });

  /** Everything held right now, by item and place: what the stores must not send elsewhere. */
  r.get('/reservations', requirePerm('sales:read', 'stock:read'), async (req, res) => {
    sendList(req, res, await rows(db, sql`
      select r.id, r.qty, r.expires_on, r.created_at, i.sku, i.name as item_name, l.name as location, u.serial_no,
             o.id as order_id, o.order_no, p.name as party_name
        from stock_reservations r join items i on i.id = r.item_id join locations l on l.id = r.location_id
        join sales_orders o on o.id = r.sales_order_id left join parties p on p.id = o.party_id left join units u on u.id = r.unit_id
       where r.status = 'open' and (r.expires_on is null or r.expires_on >= ${istDate()}::date)
       order by r.created_at desc limit 1000`), 'reservations');
  });
  return r;
}
