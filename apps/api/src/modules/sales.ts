import crypto from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  CHANNELS, D, Decimal, ORDER_STATUSES, PAYMENT_MODES, addDays, amountInWords, can, computeLine, computeTotals, formatDate, formatINR,
  isInterState, istDate, money, qty as fmtQty, round2, SELLING_PARTY_TYPES, OUTSIDE_INDIA, STATE_CODES, UNSELLABLE_LOCATION_TYPES,
  type Channel, type LineTax, type PaymentMode, type Role,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal, reverseJournals } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { getCompany, getSetting } from '../core/settings';
import { assertGstOpen } from '../core/gst-lock';
import { locationByType, lockItems, stockIn, stockOut } from '../core/stock';
import { taxRateOn } from '../core/taxrates';
import { cleanSerials, needsSerials, unitEvent, unitsIn, unitsOut } from '../core/units';
import { rows, type DB } from '../db/client';
import {
  deliveries, deliveryChecks, deliveryLines, entities, files, invoiceLines, invoiceLinks, invoices, items, leadActivities, leads, locations, parties,
  salesOrderLines, salesOrders, units,
} from '../db/schema';
import { assertOnce, badRequest, conflict, forbidden, must } from '../lib/errors';
import {
  emptyToNull, inTx, sendList, zDate, zId, zListQuery, zMoney, zMoneyPos, zPhone, zQty, zSerials, zStateCode, zText, type Ctx,
} from '../lib/http';
import { priceFor, priceListFor } from './items';
import { captureLead, convertLead, sourceIdByName } from './leads';
import { applyCredit, assertCreditsCovered, creditsFor, unapplyAllOn, unapplyCredit } from './credits';
import { cancelPayment, createPayment } from './payments';
import { partyBalance, type Party } from './parties';
import { assertFree, expireReservations, fulfil, release, reservationsOf } from './reservations';

/**
 * Selling, from the quote to the invoice.
 *
 *   draft (a quote) -> confirmed -> delivered -> invoiced        cancelled: any time before delivery
 *
 * - Confirming checks the prices (nothing below cost, no discount over the seller's limit, unless
 *   someone with sales:approve_discount confirms it) and the customer's credit (limit, overdue bills).
 * - Delivering is the step that takes stock out, at average cost (Dr Cost of Goods Sold, Cr Stock).
 * - Invoicing bills what has been delivered and not yet billed, takes the next invoice number and
 *   freezes the totals and the customer's details on the document.
 * - The store's quick bill does all of that and takes the payment, in one transaction.
 * - An issued invoice is never edited. It is corrected by a credit note (a return) or cancelled,
 *   and either way the original stays on record.
 */

export type Order = typeof salesOrders.$inferSelect;
export type OrderLine = typeof salesOrderLines.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;

export type OrderLineInput = {
  itemId: string; qty: string; rate?: string | null; discount?: string | null;
  /** The quick bill hands over at once: for a serialised item, the serials sold. */
  serials?: string[] | null;
};
export type OrderInput = {
  channel: Channel;
  /** The legal entity selling; the default one when not given. */
  entityId?: string | null;
  partyId: string | null;
  leadId?: string | null;
  externalOrderId?: string | null;
  orderDate: string;
  placeOfSupply?: string | null;
  taxInclusive?: boolean | null;
  notes?: string | null;
  lines: OrderLineInput[];
};

// ---------------------------------------------------------------------------
// Orders: a quote, then a confirmed order
// ---------------------------------------------------------------------------
async function loadParty(tx: DB, partyId: string | null): Promise<Party | null> {
  if (!partyId) return null;
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw badRequest('Party not found');
  if (party.partyType === 'supplier') throw badRequest('Sales go to a customer or dealer, not a supplier');
  if (!party.active) throw badRequest(`${party.name} is inactive`);
  return party;
}

/** Build order lines: price from the party's price list, the GST rate in force on the order's date (core/taxrates.ts). */
async function buildLines(tx: DB, party: Party | null, input: OrderLineInput[], date: string, taxInclusiveOverride?: boolean | null) {
  if (input.length === 0) throw badRequest('Add at least one item');
  const priceList = await priceListFor(tx, party);
  const taxInclusive = taxInclusiveOverride ?? priceList.taxInclusive;
  const found = await tx.select().from(items).where(inArray(items.id, [...new Set(input.map((l) => l.itemId))]));
  const byId = new Map(found.map((i) => [i.id, i]));
  const lines = [];
  for (const [idx, l] of input.entries()) {
    const item = byId.get(l.itemId);
    if (!item) throw badRequest('Item not found');
    if (!item.active) throw badRequest(`${item.name} is inactive`);
    if (item.itemType === 'raw_material') throw badRequest(`${item.name} is a raw material and cannot be sold`);
    const rate = l.rate ?? (await priceFor(tx, item, priceList));
    const discount = l.discount ?? '0';
    if (D(discount).gt(D(l.qty).times(rate))) throw badRequest(`Discount on ${item.name} is more than the line amount`);
    const tax = await taxRateOn(tx, item, date);
    lines.push({ itemId: item.id, qty: fmtQty(l.qty), rate: money(rate), discount: money(discount), gstRate: tax.gstRate, cessRate: tax.cessRate, sort: idx });
  }
  return { lines, taxInclusive };
}

/** A new order in draft, which is what a quote is. Prices come from the party's price list; GST follows the place of supply. */
export async function createOrder(ctx: Ctx, input: OrderInput): Promise<Order> {
  const { tx } = ctx;
  const party = await loadParty(tx, input.partyId);
  if (!party && input.channel !== 'store') throw badRequest('Pick a party for this order');
  if (input.entityId) {
    const [e] = await tx.select().from(entities).where(eq(entities.id, input.entityId));
    if (!e?.active) throw badRequest('That company (legal entity) does not exist or is switched off');
  }
  const company = await getCompany(tx, input.entityId);
  const { lines, taxInclusive } = await buildLines(tx, party, input.lines, input.orderDate, input.taxInclusive);
  const placeOfSupply = input.placeOfSupply ?? party?.stateCode ?? company.state_code;
  if (placeOfSupply === OUTSIDE_INDIA) throw badRequest('Sales outside India (exports) are not set up yet');
  if (!STATE_CODES[placeOfSupply]) throw badRequest('Unknown place of supply');

  const { number } = await nextNumber(tx, 'sales_order', input.orderDate, input.entityId);
  const [order] = await tx
    .insert(salesOrders)
    .values({
      orderNo: number,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      channel: input.channel,
      externalOrderId: input.externalOrderId ?? null,
      partyId: party?.id ?? null,
      // Attribution (PRD 7.10): revenue is credited to the lead's source through this link.
      leadId: input.leadId ?? party?.leadId ?? null,
      placeOfSupply,
      taxInclusive,
      orderDate: input.orderDate,
      notes: input.notes ?? null,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await tx.insert(salesOrderLines).values(lines.map((l) => ({ ...l, orderId: order!.id })));
  await audit(ctx, 'sales_order', order!.id, 'create', null, { ...order, lines });
  return order!;
}

type TotalsLine = { qty: string; rate: string; discount: string; gstRate: string; cessRate?: string | null };

/** The tax and totals of an order as they stand now: the same sums the invoice will freeze. */
export async function orderTotals(tx: DB, order: Order, lines: TotalsLine[]) {
  const company = await getCompany(tx, order.entityId);
  const inter = isInterState(company.state_code, order.placeOfSupply);
  const computed = lines.map((l) => computeLine({ qty: l.qty, rate: l.rate, discount: l.discount, gstRate: l.gstRate, cessRate: l.cessRate ?? 0 }, inter, order.taxInclusive));
  return { computed, totals: computeTotals(computed) };
}

/**
 * What a party already has on order and not yet billed: its other confirmed orders, at what is left to invoice on
 * them, with GST. It counts against the credit limit (technical review, 26 Oct 2026: "dealers can get more credit
 * than their limit", by confirming several orders that each fit inside it on their own).
 */
async function openOrdersValue(tx: DB, partyId: string, exceptOrderId: string): Promise<Decimal> {
  const open = await tx.select().from(salesOrders)
    .where(and(eq(salesOrders.partyId, partyId), inArray(salesOrders.status, ['confirmed', 'delivered']), ne(salesOrders.id, exceptOrderId)));
  let total = D(0);
  for (const o of open) {
    const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, o.id));
    const left = lines
      .map((l) => {
        const q = D(l.qty).minus(l.invoicedQty);
        return { ...l, qty: q.toString(), discount: D(l.discount).times(q).div(l.qty).toDecimalPlaces(2).toString() };
      })
      .filter((l) => D(l.qty).gt(0));
    if (left.length) total = total.plus((await orderTotals(tx, o, left)).totals.grandTotal);
  }
  return total;
}

async function lockOrder(tx: DB, id: string): Promise<{ order: Order; lines: OrderLine[] }> {
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for('update');
  must(order, 'Sales order');
  const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, id)).orderBy(asc(salesOrderLines.sort));
  return { order: order!, lines };
}

/** Order status is derived from its lines after every delivery / invoice (PRD 6.1). */
async function refreshOrderStatus(ctx: Ctx, orderId: string): Promise<Order> {
  const { tx } = ctx;
  const { order, lines } = await lockOrder(tx, orderId);
  if (order.status === 'draft' || order.status === 'cancelled') return order;
  const allInvoiced = lines.every((l) => D(l.invoicedQty).eq(l.qty));
  const allDelivered = lines.every((l) => D(l.deliveredQty).eq(l.qty));
  const status = allInvoiced ? 'invoiced' : allDelivered ? 'delivered' : 'confirmed';
  if (status === order.status) return order;
  const [updated] = await tx.update(salesOrders).set({ status, updatedAt: new Date() }).where(eq(salesOrders.id, orderId)).returning();
  await audit(ctx, 'sales_order', orderId, 'status_change', { status: order.status }, { status });
  return updated!;
}

// ---------------------------------------------------------------------------
// The price check: below cost, or more discount than the seller may give
// ---------------------------------------------------------------------------
export type PriceProblem = {
  item_id: string; item: string;
  /** What one unit sells for on this order, before GST and after the line's discount. */
  unit_price: string;
  /** Its rate on the customer's price list, on the same footing (before GST). */
  list_price: string;
  discount_pct: string;
  /** The discount the seller may give, in %; null when they may give any. */
  limit_pct: number | null;
  below_cost: boolean;
  over_limit: boolean;
};

type CheckedLine = TotalsLine & { itemId: string };

/** The discount a user may give without approval: their role's limit, none at all for a role without one, any for an approver. */
async function discountLimit(tx: DB, userId: string | null): Promise<number | null> {
  if (!userId) return null;
  const [u] = await rows<{ role: Role }>(tx, sql`select role from users where id = ${userId}`);
  if (!u || can(u.role, 'sales:approve_discount')) return null;
  return (await getSetting(tx, 'discount_limits'))[u.role] ?? 0;
}

/**
 * Each line's price before GST, after its discount, against the item's purchase cost and against its
 * rate on the customer's price list. The discount limit is the stricter of the person who priced the
 * order (who made it) and the person looking at it or confirming it, so neither can pass a price the
 * other could not. Purchase cost is read here and never sent: a problem names the item, not the cost.
 */
export async function priceProblems(tx: DB, order: Order, lines: CheckedLine[], viewerId: string | null): Promise<PriceProblem[]> {
  if (lines.length === 0) return [];
  const [party] = order.partyId ? await tx.select().from(parties).where(eq(parties.id, order.partyId)) : [];
  const priceList = await priceListFor(tx, party ?? null);
  const found = await tx.select().from(items).where(inArray(items.id, [...new Set(lines.map((l) => l.itemId))]));
  const byId = new Map(found.map((i) => [i.id, i]));
  const { computed } = await orderTotals(tx, order, lines);
  const limits = [await discountLimit(tx, order.createdBy), await discountLimit(tx, viewerId)].filter((x): x is number => x !== null);
  const limit = limits.length ? Math.min(...limits) : null;
  const problems: PriceProblem[] = [];
  for (const [i, l] of lines.entries()) {
    const item = byId.get(l.itemId);
    if (!item || D(l.qty).lte(0)) continue;
    const unit = round2(computed[i]!.taxableValue.div(l.qty));
    const listRate = D(await priceFor(tx, item, priceList));
    const listUnit = round2(priceList.taxInclusive ? listRate.times(100).div(D(l.gstRate).plus(l.cessRate ?? 0).plus(100)) : listRate);
    const discountPct = listUnit.gt(0) ? round2(listUnit.minus(unit).div(listUnit).times(100)) : D(0);
    const belowCost = D(item.purchaseCost).gt(0) && unit.lt(item.purchaseCost);
    const overLimit = limit !== null && discountPct.gt(limit);
    if (!belowCost && !overLimit) continue;
    problems.push({
      item_id: item.id, item: item.name, unit_price: money(unit), list_price: money(listUnit), discount_pct: discountPct.toFixed(2),
      limit_pct: limit, below_cost: belowCost, over_limit: overLimit,
    });
  }
  return problems;
}

/** The problems in a sentence each, for the message that refuses the order. */
function priceMessage(problems: PriceProblem[]): string {
  return problems.map((p) => (p.below_cost
    ? `${p.item} at ₹${formatINR(p.unit_price)} before GST is below its cost.`
    : `${p.item} is ${Number(p.discount_pct)}% below its list price of ₹${formatINR(p.list_price)}; your limit is ${p.limit_pct}%.`)).join(' ');
}

/** Draft to confirmed. This is where the prices and the customer's credit are checked. */
export async function confirmOrder(
  ctx: Ctx,
  id: string,
  opts: {
    overrideCredit?: boolean;
    /** Online orders: the channel has already taken the money, at the channel's own price. */
    skipCreditCheck?: boolean;
    skipPriceCheck?: boolean;
    /** Paid on the spot (the quick bill): only what is left unpaid goes on credit. */
    paidNow?: Decimal;
    /** For the message: a quick bill refused for its price can still be saved as an order for approval. */
    quickBill?: boolean;
  } = {},
): Promise<Order> {
  const { tx } = ctx;
  const { order, lines } = await lockOrder(tx, id);
  if (order.status !== 'draft') throw conflict(`Order ${order.orderNo} is already ${order.status}`);
  if (lines.length === 0) throw badRequest('Order has no items');
  const party = await loadParty(tx, order.partyId);

  // Prices: below purchase cost, or a discount over the seller's limit, needs sales:approve_discount.
  if (!opts.skipPriceCheck) {
    const problems = await priceProblems(tx, order, lines, ctx.user?.id ?? null);
    if (problems.length > 0) {
      if (ctx.user && !can(ctx.user.role, 'sales:approve_discount')) {
        throw conflict(
          `${priceMessage(problems)} The owner or Accounts must approve this price: ` +
            (opts.quickBill ? 'ask one of them to make this bill, or save it as a sales order for them to confirm.' : 'ask one of them to confirm this order.'),
          { price_problems: problems },
        );
      }
      await audit(ctx, 'sales_order', id, 'price_override', null, { lines: problems });
    }
  }

  // Credit (PRD 7.5), on whatever is not paid right now. A bill paid in full is not credit at all.
  if (party && !opts.skipCreditCheck) {
    const { totals } = await orderTotals(tx, order, lines);
    const onCredit = totals.grandTotal.minus(opts.paidNow ?? 0);
    const mayOverride = Boolean(opts.overrideCredit && ctx.user && can(ctx.user.role, 'sales:override_credit'));
    if (onCredit.gt(0)) {
      // 1. Bills already past their due date: no more credit until they are paid.
      const [late] = await rows<{ n: number; amount: string; oldest: string | null }>(tx, sql`
        select count(*)::int as n, coalesce(sum(outstanding), 0)::numeric(14,2)::text as amount, min(due_date)::text as oldest
          from v_invoice_outstanding where party_id = ${party.id} and outstanding > 0 and due_date < ${istDate()}::date`);
      if (late && late.n > 0) {
        if (!mayOverride) {
          throw conflict(
            `${party.name} has ${late.n === 1 ? 'a bill' : `${late.n} bills`} past the due date (₹${formatINR(late.amount)}, ` +
              `the oldest due ${formatDate(late.oldest!)}). Collect that first, take this one in full, or ask Accounts / the owner to override.`,
            { overdue: late.amount, overdueBills: late.n },
          );
        }
        await audit(ctx, 'sales_order', id, 'overdue_override', null, { overdue: late.amount, bills: late.n });
      }
      // 2. The credit limit: what they owe + what they have on order and not yet billed + what goes on credit now
      // must fit inside it. The party is locked first, so two orders confirmed at the same moment are counted
      // one after the other, never both against the same headroom.
      if (party.creditLimit) {
        await tx.select({ id: parties.id }).from(parties).where(eq(parties.id, party.id)).for('update');
        const onOrder = await openOrdersValue(tx, party.id, id);
        const exposure = D(await partyBalance(tx, party.id)).plus(onOrder).plus(onCredit);
        if (exposure.gt(party.creditLimit)) {
          if (!mayOverride) {
            throw conflict(
              `${party.name} would be at ${money(exposure)} against a credit limit of ${money(party.creditLimit)}` +
                `${onOrder.gt(0) ? ` (₹${formatINR(money(onOrder))} of it on orders not yet billed)` : ''}. ` +
                'Collect payment first, or ask Accounts / the owner to override.',
              { exposure: money(exposure), creditLimit: party.creditLimit },
            );
          }
          await audit(ctx, 'sales_order', id, 'credit_limit_override', null, { exposure: money(exposure), creditLimit: party.creditLimit });
        }
      }
    }
  }
  const [updated] = await tx.update(salesOrders).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
  await audit(ctx, 'sales_order', id, 'status_change', { status: 'draft' }, { status: 'confirmed' });
  return updated!;
}

/** Cancel an order nothing has been delivered on. After delivery the way back is a credit note. */
export async function cancelOrder(ctx: Ctx, id: string, reason: string): Promise<Order> {
  const { tx } = ctx;
  const { order, lines } = await lockOrder(tx, id);
  if (order.status === 'cancelled') throw conflict('Order is already cancelled');
  // "Cancelled before delivery" (PRD 6.1). After delivery the route is a credit note.
  if (lines.some((l) => D(l.deliveredQty).gt(0))) throw conflict('Goods have been delivered. Raise a credit note instead of cancelling.');
  const [updated] = await tx.update(salesOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
  await release(ctx, { orderId: id }, `Order cancelled: ${reason}`);
  await audit(ctx, 'sales_order', id, 'cancel', { status: order.status }, { status: 'cancelled', reason });
  return updated!;
}

// ---------------------------------------------------------------------------
// Delivery: the step that takes stock out
// ---------------------------------------------------------------------------
/**
 * Delivery: the step that takes stock out (partial deliveries allowed).
 * One transaction: delivery note + stock movements + Dr COGS / Cr Stock at moving-average cost.
 */
export async function deliverOrder(
  ctx: Ctx,
  orderId: string,
  input: {
    locationId?: string | null;
    /**
     * Partial delivery, or a serialised item: which lines, how much, and which serials. `issuedUnitCost`
     * marks parts that already left stock on a job card (modules/service.ts): the delivery records them
     * at that cost and moves no stock, since their cost was booked when they were fitted.
     */
    lines?: { orderLineId: string; qty: string; serials?: string[] | null; issuedUnitCost?: string }[];
    notes?: string | null;
    date?: string;
  },
) {
  const { tx } = ctx;
  const { order, lines } = await lockOrder(tx, orderId);
  if (order.status !== 'confirmed') throw conflict(`Order ${order.orderNo} is ${order.status}; only a confirmed order can be delivered`);
  if (input.lines) assertOnce(input.lines, (l) => l.orderLineId, 'order line');

  const want: { line: OrderLine; qty: Decimal; serials?: string[] | null; issuedUnitCost?: string }[] = input.lines
    ? input.lines.map((l) => {
        const line = lines.find((x) => x.id === l.orderLineId);
        if (!line) throw badRequest('Line does not belong to this order');
        return { line, qty: D(l.qty), serials: l.serials, issuedUnitCost: l.issuedUnitCost };
      })
    : lines.map((line) => ({ line, qty: D(line.qty).minus(line.deliveredQty) })).filter((x) => x.qty.gt(0));
  if (want.length === 0) throw conflict('Nothing left to deliver on this order');
  for (const w of want) {
    if (w.qty.lte(0)) throw badRequest('Delivery quantity must be more than 0');
    if (w.qty.gt(D(w.line.qty).minus(w.line.deliveredQty))) throw conflict('Cannot deliver more than the quantity still pending');
  }

  const locationId = input.locationId ?? (await locationByType(tx, order.channel === 'store' ? 'showroom' : 'stores'));
  const [location] = await tx.select().from(locations).where(eq(locations.id, locationId));
  if (!location || !location.active) throw badRequest('Location not found');
  // Parts already fitted on a job card left the workshop shelf then: where they are "delivered from" is only a record.
  const alreadyIssued = want.every((w) => w.issuedUnitCost !== undefined);
  if (!alreadyIssued) {
    if (location.type === 'rejected') throw badRequest('Rejected stock cannot be sold');
    if ((UNSELLABLE_LOCATION_TYPES as readonly string[]).includes(location.type)) throw badRequest(`Goods at ${location.name} cannot be delivered from there`);
  }

  const date = input.date ?? istDate();
  await expireReservations(ctx);
  const itemRows = await lockItems(tx, want.map((w) => w.line.itemId));
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  // A vehicle is handed over only once its delivery checklist is complete (brief P2).
  const vehicles = want.filter((w) => w.issuedUnitCost === undefined && itemById.get(w.line.itemId)!.itemType === 'vehicle');
  if (vehicles.length) await assertDeliveryChecks(tx, orderId, itemById.get(vehicles[0]!.line.itemId)!.name);
  const { number } = await nextNumber(tx, 'delivery', date, order.entityId);
  const [delivery] = await tx
    .insert(deliveries)
    .values({ deliveryNo: number, orderId, locationId, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null })
    .returning();

  let cogs = D(0);
  for (const w of want) {
    const item = itemById.get(w.line.itemId)!;
    let unitCost = D(0);
    // A serialised item is handed over by serial: each named unit leaves the shelf and is marked sold.
    const serials = w.issuedUnitCost === undefined && needsSerials(item) ? cleanSerials(item, w.qty, w.serials) : null;
    let soldUnits: string[] = [];
    if (w.issuedUnitCost !== undefined) {
      unitCost = D(w.issuedUnitCost);
    } else if (serials) {
      // A unit reserved can go only on the order it is reserved for.
      const held = await rows<{ serial_no: string; sales_order_id: string }>(tx, sql`
        select u.serial_no, r.sales_order_id from units u join stock_reservations r on r.unit_id = u.id and r.status = 'open'
         where u.item_id = ${item.id} and u.status = 'reserved'`);
      const others = held.find((h) => serials.includes(h.serial_no) && h.sales_order_id !== orderId);
      if (others) throw conflict(`${item.name} ${others.serial_no} is reserved for another order`);
      const out = await unitsOut(ctx, {
        item, locationId, serials, movementType: 'sale_out', refType: 'delivery', refId: delivery!.id, event: 'sold', status: 'sold', soldOn: date,
        fromStatuses: ['available', 'demo', 'reserved'],
      });
      cogs = cogs.plus(out.value);
      unitCost = out.value.div(w.qty).toDecimalPlaces(2);
      soldUnits = out.units.map((u) => u.id);
    } else if (item.isStockItem) {
      await assertFree(ctx, item, locationId, w.qty, orderId);
      const out = await stockOut(ctx, {
        itemId: item.id, locationId, qty: w.qty, movementType: 'sale_out', refType: 'delivery', refId: delivery!.id,
        itemName: item.name, fallbackCost: item.purchaseCost,
      });
      cogs = cogs.plus(out.value);
      unitCost = out.value.div(w.qty).toDecimalPlaces(2);
    }
    const [dl] = await tx.insert(deliveryLines).values({
      deliveryId: delivery!.id, orderLineId: w.line.id, itemId: item.id, qty: fmtQty(w.qty), unitCost: money(unitCost), serials,
    }).returning();
    // The invoice for this line picks these units up and prints their serials.
    if (soldUnits.length) {
      await tx.update(units).set({ soldDeliveryLineId: dl!.id, soldInvoiceLineId: null }).where(inArray(units.id, soldUnits));
    }
    if (item.isStockItem && w.issuedUnitCost === undefined) await fulfil(ctx, w.line.id, locationId, w.qty, soldUnits);
    await tx
      .update(salesOrderLines)
      .set({ deliveredQty: fmtQty(D(w.line.deliveredQty).plus(w.qty)) })
      .where(eq(salesOrderLines.id, w.line.id));
  }
  await postJournal(ctx, {
    date,
    refType: 'delivery',
    refId: delivery!.id,
    narration: `Cost of goods delivered, ${number} (order ${order.orderNo})`,
    lines: [{ account: 'cogs', debit: cogs }, { account: 'stock', credit: cogs }],
  });
  await audit(ctx, 'delivery', delivery!.id, 'create', null, { ...delivery, lines: want.map((w) => ({ orderLineId: w.line.id, qty: fmtQty(w.qty) })) });
  // The lead that booked this vehicle has now taken delivery.
  if (vehicles.length && order.leadId) {
    const [lead] = await tx.select({ id: leads.id, stage: leads.stage }).from(leads).where(eq(leads.id, order.leadId)).for('update');
    if (lead?.stage === 'booked') {
      await tx.update(leads).set({ stage: 'delivered', nextFollowUpAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id));
      await tx.insert(leadActivities).values({ leadId: lead.id, type: 'stage_change', note: `Booked -> Delivered (${number})`, userId: ctx.user?.id ?? null });
    }
  }
  const updatedOrder = await refreshOrderStatus(ctx, orderId);
  return { delivery: delivery!, order: updatedOrder };
}

/** The five checks before a vehicle is handed over; refused with the ones still missing named. */
export async function assertDeliveryChecks(tx: DB, orderId: string, vehicle: string) {
  const [c] = await tx.select().from(deliveryChecks).where(eq(deliveryChecks.salesOrderId, orderId));
  const missing = [
    !c?.pdiDone && 'the pre-delivery inspection', !c?.riderBriefing && 'the rider briefing', !c?.warrantyRegistered && 'the warranty registration',
    !c?.photoFileId && 'a photo at delivery', !c?.signedNoteFileId && 'the signed delivery note',
  ].filter(Boolean);
  if (missing.length) throw conflict(`${vehicle} is a vehicle: it is handed over once its delivery checklist is done. Still to do: ${missing.join(', ')}.`);
}

export type DeliveryChecksInput = { pdiDone?: boolean; riderBriefing?: boolean; warrantyRegistered?: boolean; photoFileId?: string | null; signedNoteFileId?: string | null };

/** Record the delivery checklist of an order (a vehicle's), ticking what is done and attaching the photo and the signed note. */
export async function saveDeliveryChecks(ctx: Ctx, orderId: string, input: DeliveryChecksInput) {
  const { tx } = ctx;
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for('update');
  must(order, 'Sales order');
  for (const fileId of [input.photoFileId, input.signedNoteFileId].filter(Boolean) as string[]) {
    const [f] = await tx.select({ purpose: files.purpose }).from(files).where(eq(files.id, fileId));
    if (!f) throw badRequest('That file was not found');
  }
  const values = {
    ...(input.pdiDone !== undefined ? { pdiDone: input.pdiDone } : {}), ...(input.riderBriefing !== undefined ? { riderBriefing: input.riderBriefing } : {}),
    ...(input.warrantyRegistered !== undefined ? { warrantyRegistered: input.warrantyRegistered } : {}),
    ...(input.photoFileId !== undefined ? { photoFileId: input.photoFileId } : {}), ...(input.signedNoteFileId !== undefined ? { signedNoteFileId: input.signedNoteFileId } : {}),
    checkedBy: ctx.user?.id ?? null, updatedAt: new Date(),
  };
  const [row] = await tx.insert(deliveryChecks).values({ salesOrderId: orderId, ...values, createdBy: ctx.user?.id ?? null })
    .onConflictDoUpdate({ target: deliveryChecks.salesOrderId, set: values }).returning();
  await audit(ctx, 'sales_order', orderId, 'delivery_checks', null, row);
  return row!;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
/**
 * Invoice everything delivered and not yet invoiced on an order.
 * Draft -> lines -> Issued in one transaction: the gap-free number is taken at issue, the
 * totals and party details are frozen on the document, and the journal is posted:
 * Dr Debtors - Cr Sales - Cr Output CGST/SGST/IGST (PRD 7.8).
 */
export async function invoiceOrder(ctx: Ctx, orderId: string, input: { invoiceDate?: string; notes?: string | null } = {}): Promise<Invoice> {
  const { tx } = ctx;
  const { order, lines } = await lockOrder(tx, orderId);
  if (order.status !== 'confirmed' && order.status !== 'delivered') {
    throw conflict(`Order ${order.orderNo} is ${order.status} and cannot be invoiced`);
  }
  const pending = lines.map((line) => ({ line, qty: D(line.deliveredQty).minus(line.invoicedQty) })).filter((x) => x.qty.gt(0));
  if (pending.length === 0) throw conflict('Nothing delivered is waiting to be invoiced');

  const party = await loadParty(tx, order.partyId);
  const company = await getCompany(tx, order.entityId);
  const inter = isInterState(company.state_code, order.placeOfSupply);
  const invoiceDate = input.invoiceDate ?? istDate();
  await assertGstOpen(tx, invoiceDate, 'sales', 'no invoice can be dated in it');
  const itemRows = await tx.select().from(items).where(inArray(items.id, pending.map((p) => p.line.itemId)));
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  const [draft] = await tx
    .insert(invoices)
    .values({
      docType: 'tax_invoice', invoiceDate, partyId: order.partyId, orderId, channel: order.channel, entityId: order.entityId,
      placeOfSupply: order.placeOfSupply, taxInclusive: order.taxInclusive, status: 'draft', notes: input.notes ?? null,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();

  const computed: LineTax[] = [];
  for (const [idx, p] of pending.entries()) {
    const item = itemById.get(p.line.itemId)!;
    // HSN/SAC is mandatory on a tax invoice (PRD 7.9).
    if (!item.hsnSac) throw badRequest(`${item.name} has no HSN/SAC code. Add it to the item before invoicing.`);
    // Line discount is for the whole ordered quantity: pro-rate it, and let the final
    // part-invoice take the remainder so the pieces always add up to the original.
    const completes = D(p.line.invoicedQty).plus(p.qty).eq(p.line.qty);
    let discount: Decimal;
    if (completes) {
      const [prev] = await rows<{ d: string }>(tx, sql`
        select coalesce(sum(il.discount), 0)::text as d from invoice_lines il join invoices i on i.id = il.invoice_id
         where il.order_line_id = ${p.line.id} and i.doc_type = 'tax_invoice' and i.status = 'issued'`);
      discount = D(p.line.discount).minus(prev?.d ?? 0);
    } else discount = D(p.line.discount).times(p.qty).div(p.line.qty).toDecimalPlaces(2);
    const [cost] = await rows<{ c: string | null }>(tx, sql`
      select (sum(qty * unit_cost) / nullif(sum(qty), 0))::numeric(12,2)::text as c from delivery_lines where order_line_id = ${p.line.id}`);
    // GST is due at the rate in force on the invoice date (the time of supply), even if it changed after the order.
    const onDate = await taxRateOn(tx, { hsnSac: item.hsnSac, gstRate: p.line.gstRate, cessRate: p.line.cessRate }, invoiceDate);
    const tax = computeLine({ qty: p.qty, rate: p.line.rate, discount, gstRate: onDate.gstRate, cessRate: onDate.cessRate }, inter, order.taxInclusive);
    computed.push(tax);
    // The serials delivered on this order line and not billed yet go on the bill (a vehicle's frame number must).
    const billed = await rows<{ id: string; serial_no: string }>(tx, sql`
      select u.id, u.serial_no from units u join delivery_lines dl on dl.id = u.sold_delivery_line_id
       where dl.order_line_id = ${p.line.id} and u.sold_invoice_line_id is null and u.status = 'sold' order by u.serial_no`);
    const [invLine] = await tx.insert(invoiceLines).values({
      invoiceId: draft!.id, orderLineId: p.line.id, itemId: item.id, description: item.name, hsnSac: item.hsnSac, unit: item.unit,
      qty: fmtQty(p.qty), rate: p.line.rate, discount: money(discount), taxableValue: money(tax.taxableValue),
      gstRate: onDate.gstRate, cgst: money(tax.cgst), sgst: money(tax.sgst), igst: money(tax.igst),
      cessRate: onDate.cessRate, cess: money(tax.cess),
      lineTotal: money(tax.lineTotal), unitCost: money(cost?.c ?? 0), sort: idx,
      serials: billed.length ? billed.map((u) => u.serial_no) : null,
    }).returning();
    if (billed.length) await tx.update(units).set({ soldInvoiceLineId: invLine!.id }).where(inArray(units.id, billed.map((u) => u.id)));
    await tx.update(salesOrderLines).set({ invoicedQty: fmtQty(D(p.line.invoicedQty).plus(p.qty)) }).where(eq(salesOrderLines.id, p.line.id));
  }

  const totals = computeTotals(computed);
  const { number, fy } = await nextNumber(tx, 'invoice', invoiceDate, order.entityId);
  const [issued] = await tx
    .update(invoices)
    .set({
      invoiceNo: number, fy, status: 'issued', issuedAt: new Date(),
      partyName: party?.name ?? 'Cash Sale', partyGstin: party?.gstin ?? null, partyPhone: party?.phone ?? null,
      billingAddress: party?.billingAddress ?? null, shippingAddress: party?.shippingAddress ?? party?.billingAddress ?? null,
      taxableTotal: money(totals.taxableTotal), cgstTotal: money(totals.cgstTotal), sgstTotal: money(totals.sgstTotal),
      igstTotal: money(totals.igstTotal), cessTotal: money(totals.cessTotal), roundOff: money(totals.roundOff), grandTotal: money(totals.grandTotal),
      dueDate: addDays(invoiceDate, party?.paymentTermsDays ?? 0), updatedAt: new Date(),
    })
    .where(eq(invoices.id, draft!.id))
    .returning();

  await postJournal(ctx, {
    date: invoiceDate,
    refType: 'invoice',
    refId: issued!.id,
    narration: `Sales invoice ${number} - ${issued!.partyName}`,
    entityId: order.entityId,
    lines: [
      { account: 'debtors', partyId: order.partyId, debit: totals.grandTotal },
      { account: 'sales', credit: totals.taxableTotal },
      { account: 'output_cgst', credit: totals.cgstTotal },
      { account: 'output_sgst', credit: totals.sgstTotal },
      { account: 'output_igst', credit: totals.igstTotal },
      { account: 'output_cess', credit: totals.cessTotal },
      { account: 'round_off', credit: totals.roundOff },
    ],
  });
  await audit(ctx, 'invoice', issued!.id, 'issue', null, issued);
  await refreshOrderStatus(ctx, orderId);
  return issued!;
}

// ---------------------------------------------------------------------------
// Quick bill: order, delivery, invoice and payment in one go
// ---------------------------------------------------------------------------
export type QuickBillInput = {
  partyId?: string | null;
  customer?: { phone: string; name: string } | null;
  lines: OrderLineInput[];
  payments: { mode: PaymentMode; amount: string; accountId?: string | null; reference?: string | null }[];
  locationId?: string | null;
  notes?: string | null;
  /** Accounts / the owner: bill on credit past the limit or with bills overdue (sales:override_credit). */
  overrideCredit?: boolean;
  /** Selling a vehicle at the counter: its delivery checklist, done before it is handed over. */
  deliveryChecks?: DeliveryChecksInput | null;
};

/**
 * Store quick bill (PRD 7.4). ONE database transaction creates the sales order
 * (channel = Store), the issued GST invoice with its next number, the stock movement out
 * of the Showroom, the payments with their allocation, and all journal entries. If any
 * step fails (not enough stock, period locked, ...) nothing at all is saved.
 */
export async function quickBill(ctx: Ctx, input: QuickBillInput) {
  const { tx } = ctx;
  const today = istDate();

  let partyId = input.partyId ?? null;
  let leadId: string | null = null;
  if (!partyId && input.customer) {
    // A walk-in buying on the spot is still recorded as a lead, then converted (New -> Converted).
    const [existing] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.phone, input.customer.phone), inArray(parties.partyType, [...SELLING_PARTY_TYPES])))
      .orderBy(asc(parties.createdAt))
      .limit(1);
    if (existing) partyId = existing.id;
    else {
      const captured = await captureLead(ctx, {
        name: input.customer.name, phone: input.customer.phone, sourceId: await sourceIdByName(tx, 'Walk-in'),
        interestedItemIds: input.lines.map((l) => l.itemId), attendedBy: ctx.user?.id ?? null,
      });
      const converted = await convertLead(ctx, captured.lead.id, { partyType: 'customer', name: input.customer.name });
      partyId = converted.party.id;
      leadId = converted.lead.id;
    }
  }

  const order = await createOrder(ctx, { channel: 'store', partyId, leadId, orderDate: today, lines: input.lines, notes: input.notes });
  // The same price and credit checks as any order. Credit is only what is not paid now, so a bill
  // paid in full skips the credit check, and a part-paid one is checked on the unpaid part.
  const paid = input.payments.reduce((a, p) => a.plus(p.amount), D(0));
  await confirmOrder(ctx, order.id, { paidNow: paid, overrideCredit: input.overrideCredit, quickBill: true });
  if (input.deliveryChecks) await saveDeliveryChecks(ctx, order.id, input.deliveryChecks);
  // The lines are delivered in full, each with the serials picked at the counter (order lines keep the bill's order).
  const orderLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id)).orderBy(asc(salesOrderLines.sort));
  await deliverOrder(ctx, order.id, {
    locationId: input.locationId ?? (await locationByType(tx, 'showroom')), date: today,
    lines: orderLines.map((l, i) => ({ orderLineId: l.id, qty: l.qty, serials: input.lines[i]?.serials })),
  });
  const invoice = await invoiceOrder(ctx, order.id, { invoiceDate: today, notes: input.notes });

  if (paid.gt(invoice.grandTotal)) {
    throw badRequest(`Payments (${money(paid)}) are more than the bill (${invoice.grandTotal}). Enter the amount kept, not the cash handed over.`);
  }
  // "Credit" = whatever is left unpaid. That needs a named party to owe it.
  if (paid.lt(invoice.grandTotal) && !partyId) {
    throw badRequest('A cash sale without a customer must be paid in full. Add the customer to sell on credit.');
  }
  const made = [];
  for (const p of input.payments) {
    if (D(p.amount).lte(0)) continue;
    made.push(await createPayment(ctx, {
      direction: 'in', partyId, mode: p.mode, accountId: p.accountId, amount: p.amount, reference: p.reference,
      paidOn: today, allocations: [{ invoiceId: invoice.id, amount: p.amount }],
    }));
  }
  return { order_id: order.id, invoice, payments: made, balance_due: money(D(invoice.grandTotal).minus(paid)) };
}

// ---------------------------------------------------------------------------
// Corrections: credit notes and cancelling an invoice
// ---------------------------------------------------------------------------
/**
 * Credit note = sales return (PRD 7.8). Amounts are pro-rated from the original invoice
 * lines so that crediting a whole invoice reverses it to the paisa. With restock, the
 * goods come back into stock at the cost they went out at.
 */
export async function createCreditNote(
  ctx: Ctx,
  invoiceId: string,
  input: { lines: { invoiceLineId: string; qty: string; serials?: string[] | null }[]; restock: boolean; locationId?: string | null; reason: string; date?: string },
): Promise<Invoice> {
  const { tx } = ctx;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  must(inv, 'Invoice');
  if (inv!.docType !== 'tax_invoice' || inv!.status !== 'issued') throw conflict('A credit note needs an issued tax invoice');
  if (input.lines.length === 0) throw badRequest('Pick at least one line to return');
  assertOnce(input.lines, (l) => l.invoiceLineId, 'invoice line');
  const date = input.date ?? istDate();
  if (date < inv!.invoiceDate) throw badRequest('Credit note cannot be dated before its invoice');
  await assertGstOpen(tx, date, 'sales', 'no credit note can be dated in it');

  const origLines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.sort));
  const prior = await rows<{ against_line_id: string; qty: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string }>(tx, sql`
    select il.against_line_id, sum(il.qty)::text as qty, sum(il.taxable_value)::text as taxable,
           sum(il.cgst)::text as cgst, sum(il.sgst)::text as sgst, sum(il.igst)::text as igst, sum(il.cess)::text as cess
      from invoice_lines il join invoices cn on cn.id = il.invoice_id
     where cn.against_invoice_id = ${invoiceId} and cn.doc_type = 'credit_note' and cn.status = 'issued'
     group by il.against_line_id`);
  const priorByLine = new Map(prior.map((p) => [p.against_line_id, p]));

  const [draft] = await tx
    .insert(invoices)
    .values({
      docType: 'credit_note', invoiceDate: date, partyId: inv!.partyId, orderId: inv!.orderId, againstInvoiceId: invoiceId, entityId: inv!.entityId,
      channel: inv!.channel, placeOfSupply: inv!.placeOfSupply, taxInclusive: inv!.taxInclusive, status: 'draft',
      reason: input.reason, createdBy: ctx.user?.id ?? null,
    })
    .returning();

  let taxable = D(0), cgst = D(0), sgst = D(0), igst = D(0), cess = D(0);
  const restockLines: { itemId: string; qty: Decimal; unitCost: string; serials: string[] | null }[] = [];
  const serialised = new Map((await tx.select().from(items).where(inArray(items.id, origLines.map((o) => o.itemId)))).map((i) => [i.id, i]));
  const seen = new Set<string>();
  for (const [idx, l] of input.lines.entries()) {
    const orig = origLines.find((o) => o.id === l.invoiceLineId);
    if (!orig) throw badRequest('Line does not belong to this invoice');
    if (seen.has(orig.id)) throw badRequest('The same line is listed twice');
    seen.add(orig.id);
    const p = priorByLine.get(orig.id);
    const q = D(l.qty);
    const remaining = D(orig.qty).minus(p?.qty ?? 0);
    if (q.gt(remaining)) throw conflict(`Only ${fmtQty(remaining)} of ${orig.description} is left to return`);
    const completes = q.eq(remaining);
    const part = (total: string, already: string | undefined) =>
      completes ? D(total).minus(already ?? 0) : D(total).times(q).div(orig.qty).toDecimalPlaces(2);
    const lt = part(orig.taxableValue, p?.taxable), lc = part(orig.cgst, p?.cgst), ls = part(orig.sgst, p?.sgst), li = part(orig.igst, p?.igst);
    const lx = part(orig.cess, p?.cess);
    // A serialised item coming back on the shelf comes back by serial: units sold on this very line.
    const item = serialised.get(orig.itemId)!;
    const back = input.restock && needsSerials(item) ? cleanSerials(item, q, l.serials) : null;
    if (back) {
      const mine = await tx.select({ serialNo: units.serialNo }).from(units)
        .where(and(eq(units.soldInvoiceLineId, orig.id), eq(units.status, 'sold'), inArray(units.serialNo, back)));
      const stranger = back.find((s) => !mine.some((u) => u.serialNo === s));
      if (stranger) throw badRequest(`${item.name} ${stranger} was not sold on this invoice line`);
    }
    taxable = taxable.plus(lt); cgst = cgst.plus(lc); sgst = sgst.plus(ls); igst = igst.plus(li); cess = cess.plus(lx);
    await tx.insert(invoiceLines).values({
      invoiceId: draft!.id, againstLineId: orig.id, orderLineId: orig.orderLineId, itemId: orig.itemId, description: orig.description,
      hsnSac: orig.hsnSac, unit: orig.unit, qty: fmtQty(q), rate: orig.rate,
      discount: money(D(orig.discount).times(q).div(orig.qty)), taxableValue: money(lt), gstRate: orig.gstRate,
      cgst: money(lc), sgst: money(ls), igst: money(li), cessRate: orig.cessRate, cess: money(lx),
      lineTotal: money(lt.plus(lc).plus(ls).plus(li).plus(lx)),
      unitCost: orig.unitCost, sort: idx, serials: back ?? (l.serials?.length ? l.serials : null),
    });
    restockLines.push({ itemId: orig.itemId, qty: q, unitCost: orig.unitCost, serials: back });
  }

  // If this note finishes off the whole invoice, give back the rupee round-off too.
  const [after] = await rows<{ left: string }>(tx, sql`
    select (select coalesce(sum(qty), 0) from invoice_lines where invoice_id = ${invoiceId})
         - (select coalesce(sum(il.qty), 0) from invoice_lines il join invoices cn on cn.id = il.invoice_id
             where cn.against_invoice_id = ${invoiceId} and cn.doc_type = 'credit_note' and (cn.status = 'issued' or cn.id = ${draft!.id})) as left`);
  let roundOff = D(0);
  if (D(after?.left ?? 1).isZero()) {
    const [pr] = await rows<{ r: string }>(tx, sql`
      select coalesce(sum(round_off), 0)::text as r from invoices
       where against_invoice_id = ${invoiceId} and doc_type = 'credit_note' and status = 'issued'`);
    roundOff = D(inv!.roundOff).minus(pr?.r ?? 0);
  }
  const grand = taxable.plus(cgst).plus(sgst).plus(igst).plus(cess).plus(roundOff);

  const { number, fy } = await nextNumber(tx, 'credit_note', date, inv!.entityId);
  const [issued] = await tx
    .update(invoices)
    .set({
      invoiceNo: number, fy, status: 'issued', issuedAt: new Date(), partyName: inv!.partyName, partyGstin: inv!.partyGstin,
      partyPhone: inv!.partyPhone, billingAddress: inv!.billingAddress, shippingAddress: inv!.shippingAddress,
      taxableTotal: money(taxable), cgstTotal: money(cgst), sgstTotal: money(sgst), igstTotal: money(igst), cessTotal: money(cess),
      roundOff: money(roundOff), grandTotal: money(grand), updatedAt: new Date(),
    })
    .where(eq(invoices.id, draft!.id))
    .returning();

  await postJournal(ctx, {
    date,
    refType: 'credit_note',
    refId: issued!.id,
    narration: `Credit note ${number} against ${inv!.invoiceNo} - ${input.reason}`,
    entityId: inv!.entityId,
    lines: [
      { account: 'sales', debit: taxable },
      { account: 'output_cgst', debit: cgst },
      { account: 'output_sgst', debit: sgst },
      { account: 'output_igst', debit: igst },
      { account: 'output_cess', debit: cess },
      { account: 'round_off', debit: roundOff },
      { account: 'debtors', partyId: inv!.partyId, credit: grand },
    ],
  });

  if (input.restock) {
    const locationId = input.locationId ?? (await locationByType(tx, 'showroom'));
    const itemRows = await lockItems(tx, restockLines.map((l) => l.itemId));
    const stockIds = new Set(itemRows.filter((i) => i.isStockItem).map((i) => i.id));
    let value = D(0);
    for (const l of restockLines) {
      if (!stockIds.has(l.itemId)) continue;
      value = value.plus(l.serials
        ? await unitsIn(ctx, {
            item: itemRows.find((i) => i.id === l.itemId)!, locationId, serials: l.serials, unitCost: l.unitCost, movementType: 'sales_return_in',
            refType: 'credit_note', refId: issued!.id, event: 'returned', reason: input.reason, returning: true,
          })
        : await stockIn(ctx, {
            itemId: l.itemId, locationId, qty: l.qty, unitCost: l.unitCost, movementType: 'sales_return_in',
            refType: 'credit_note', refId: issued!.id, reason: input.reason,
          }));
    }
    await postJournal(ctx, {
      date, refType: 'credit_note', refId: issued!.id, narration: `Goods returned to stock, ${number}`,
      lines: [{ account: 'stock', debit: value }, { account: 'cogs', credit: value }],
    });
  }
  await audit(ctx, 'invoice', issued!.id, 'issue_credit_note', null, { ...issued, restock: input.restock });
  return issued!;
}

/**
 * Cancel an issued invoice (PRD 7.8: corrections are cancel-and-reissue or a credit note,
 * never an edit). The number stays used, the document stays on record as Cancelled, and
 * mirror journal entries undo its accounting.
 */
export async function cancelInvoice(
  ctx: Ctx,
  id: string,
  input: { reason: string; restock: boolean; cancelPayments: boolean },
): Promise<Invoice> {
  const { tx } = ctx;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
  must(inv, 'Invoice');
  if (inv!.status !== 'issued') throw conflict(`This document is ${inv!.status}`);
  // Already in a filed GSTR-1: cancelling would change that return behind it.
  await assertGstOpen(tx, inv!.invoiceDate, 'sales', `${inv!.invoiceNo} cannot be cancelled`);
  const today = istDate();

  if (inv!.docType === 'tax_invoice') {
    const [cn] = await rows(tx, sql`
      select 1 as x from invoices where against_invoice_id = ${id} and doc_type = 'credit_note' and status = 'issued' limit 1`);
    if (cn) throw conflict('This invoice has a credit note against it and cannot be cancelled');
    // Credit from other invoices' returns that was set against this one goes back to being available.
    await unapplyAllOn(ctx, id, `Invoice ${inv!.invoiceNo} cancelled`);

    const paid = await rows<{ payment_id: string; payment_no: string; amount: string; allocated_here: string; allocated_all: string }>(tx, sql`
      select p.id as payment_id, p.payment_no, (p.amount + p.tds_amount)::text as amount,
             sum(pa.amount) filter (where pa.invoice_id = ${id})::text as allocated_here,
             sum(pa.amount)::text as allocated_all
        from payments p join payment_allocations pa on pa.payment_id = p.id
       where p.status = 'posted'
         and p.id in (select payment_id from payment_allocations where invoice_id = ${id})
       group by p.id, p.payment_no, p.amount, p.tds_amount`);
    if (paid.length > 0) {
      if (!input.cancelPayments) {
        throw conflict('Payments are allocated to this invoice. Cancel them too, or raise a credit note instead.',
          { payments: paid.map((p) => p.payment_no) });
      }
      for (const p of paid) {
        // Only auto-cancel a receipt that exists purely for this invoice.
        if (!D(p.allocated_here).eq(p.amount) || !D(p.allocated_all).eq(p.amount)) {
          throw conflict(`Receipt ${p.payment_no} also covers other invoices or an advance. Sort that out first, or raise a credit note.`);
        }
        await cancelPayment(ctx, p.payment_id, `Invoice ${inv!.invoiceNo} cancelled`);
      }
    }
  }

  if (inv!.docType === 'credit_note') {
    const [used] = await rows<{ invoice_no: string }>(tx, sql`
      select i.invoice_no from credit_applications ca join invoices i on i.id = ca.invoice_id
       where ca.credit_note_id = ${id} and ca.status = 'posted' limit 1`);
    if (used) throw conflict(`This credit note's credit has been used against ${used.invoice_no}. Take it back there first.`);
  }

  const [cancelled] = await tx
    .update(invoices)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: input.reason, updatedAt: new Date() })
    .where(eq(invoices.id, id))
    .returning();
  // Cancelling one credit note shrinks the credit its invoice gave rise to; a sibling note's credit may already be spent.
  if (inv!.docType === 'credit_note' && inv!.againstInvoiceId) await assertCreditsCovered(tx, [inv!.againstInvoiceId]);
  await reverseJournals(ctx, inv!.docType === 'tax_invoice' ? 'invoice' : 'credit_note', id, today, `Cancelled ${inv!.invoiceNo}: ${input.reason}`);

  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  if (inv!.docType === 'credit_note') {
    // Undo a restock: the journal reversal above already moved the value, so take the goods back out.
    const moved = await rows<{ item_id: string; location_id: string; qty: string; unit_cost: string; unit_id: string | null }>(tx, sql`
      select item_id, location_id, qty::text, unit_cost::text, unit_id from stock_movements where ref_type = 'credit_note' and ref_id = ${id}`);
    if (moved.length) {
      await lockItems(tx, moved.map((m) => m.item_id));
      for (const m of moved) {
        await stockOut(ctx, {
          itemId: m.item_id, locationId: m.location_id, qty: m.qty, unitCostOverride: m.unit_cost,
          movementType: 'sales_return_in', refType: 'credit_note_cancel', refId: id, reason: input.reason, unitId: m.unit_id,
        });
        // The return did not happen after all: the unit is the customer's again.
        if (m.unit_id) {
          const [u] = await tx.select().from(units).where(eq(units.id, m.unit_id)).for('update');
          if (u?.locationId !== m.location_id) throw conflict(`${u?.serialNo ?? 'A unit'} from this return has moved since; bring it back first`);
          await tx.update(units).set({ status: 'sold', locationId: null, updatedAt: new Date() }).where(eq(units.id, m.unit_id));
          await unitEvent(ctx, { unitId: m.unit_id, event: 'return_cancelled', from: { locationId: u.locationId, status: u.status }, to: { locationId: null, status: 'sold' }, refType: 'credit_note_cancel', refId: id, note: input.reason });
        }
      }
    }
  } else if (inv!.orderId) {
    const stockItems = input.restock ? await lockItems(tx, lines.map((l) => l.itemId)) : [];
    const isStock = new Set(stockItems.filter((i) => i.isStockItem).map((i) => i.id));
    const locationId = input.restock ? await locationByType(tx, 'showroom') : null;
    let value = D(0);
    for (const l of lines) {
      if (!l.orderLineId) continue;
      const [ol] = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.id, l.orderLineId)).for('update');
      if (!ol) continue;
      const patch: Partial<typeof salesOrderLines.$inferInsert> = { invoicedQty: fmtQty(D(ol.invoicedQty).minus(l.qty)) };
      if (input.restock) {
        // The sale is void: the goods never really left, so put them back at the cost they went out at.
        patch.deliveredQty = fmtQty(D(ol.deliveredQty).minus(l.qty));
        const item = stockItems.find((i) => i.id === l.itemId);
        if (item && needsSerials(item)) {
          // The units billed on this line come back by serial.
          const sold = await rows<{ serial_no: string }>(tx, sql`select serial_no from units where sold_invoice_line_id = ${l.id} and status = 'sold' order by serial_no`);
          value = value.plus(await unitsIn(ctx, {
            item, locationId: locationId!, serials: sold.map((u) => u.serial_no), unitCost: l.unitCost, movementType: 'sales_return_in',
            refType: 'invoice_cancel', refId: id, event: 'sale_cancelled', reason: input.reason, returning: true,
          }));
        } else if (isStock.has(l.itemId)) {
          value = value.plus(await stockIn(ctx, {
            itemId: l.itemId, locationId: locationId!, qty: l.qty, unitCost: l.unitCost, movementType: 'sales_return_in',
            refType: 'invoice_cancel', refId: id, reason: input.reason,
          }));
        }
      } else {
        // Billed again later: the units sold stay sold, waiting for the next invoice of this order line.
        await tx.update(units).set({ soldInvoiceLineId: null }).where(eq(units.soldInvoiceLineId, l.id));
      }
      await tx.update(salesOrderLines).set(patch).where(eq(salesOrderLines.id, ol.id));
    }
    if (input.restock) {
      await postJournal(ctx, {
        date: today, refType: 'invoice_cancel', refId: id, narration: `Goods back in stock, ${inv!.invoiceNo} cancelled`,
        lines: [{ account: 'stock', debit: value }, { account: 'cogs', credit: value }],
      });
    }
    const { order, lines: orderLines } = await lockOrder(tx, inv!.orderId);
    if (input.restock && orderLines.every((ol) => D(ol.deliveredQty).isZero())) {
      await tx.update(salesOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(salesOrders.id, order.id));
      await audit(ctx, 'sales_order', order.id, 'cancel', { status: order.status }, { status: 'cancelled', reason: input.reason });
    } else {
      // invoiced -> delivered/confirmed again, ready to be re-invoiced correctly.
      await tx.update(salesOrders).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(salesOrders.id, order.id));
      await refreshOrderStatus(ctx, order.id);
    }
  }
  await audit(ctx, 'invoice', id, 'cancel', { status: 'issued' }, { status: 'cancelled', reason: input.reason, restock: input.restock });
  return cancelled!;
}

// ---------------------------------------------------------------------------
// The invoice as a document, and the link that shows it
// ---------------------------------------------------------------------------
/** The link's key for an invoice, made the first time the invoice is shared. It says nothing about the invoice. */
export async function shareTokenFor(ctx: Ctx, invoiceId: string): Promise<string> {
  const [inv] = await ctx.tx.select({ id: invoices.id, status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
  must(inv, 'Invoice');
  if (inv!.status === 'draft') throw badRequest('This invoice has not been issued yet');
  // Two people sharing the same bill at the same moment get the same link.
  const [made] = await ctx.tx.insert(invoiceLinks)
    .values({ invoiceId, token: crypto.randomBytes(16).toString('base64url'), createdBy: ctx.user?.id ?? null })
    .onConflictDoNothing().returning({ token: invoiceLinks.token });
  if (made) {
    await audit(ctx, 'invoice', invoiceId, 'share', null, { shared: true });
    return made.token;
  }
  const [kept] = await ctx.tx.select({ token: invoiceLinks.token }).from(invoiceLinks).where(eq(invoiceLinks.invoiceId, invoiceId));
  return kept!.token;
}

/** Everything needed to show or print a tax invoice / credit note (PRD 7.9, 7.11). */
export async function invoiceDocument(tx: DB, id: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id));
  must(inv, 'Invoice');
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sort));
  const [outstanding] = await rows(tx, sql`
    select allocated, credited, outstanding, payment_status from v_invoice_outstanding where invoice_id = ${id}`);
  const paymentsMade = await rows(tx, sql`
    select p.id, p.payment_no, p.paid_on, p.mode, p.reference, pa.amount
      from payment_allocations pa join payments p on p.id = pa.payment_id
     where pa.invoice_id = ${id} and p.status = 'posted' order by p.paid_on, p.created_at`);
  const creditNotes = await rows(tx, sql`
    select id, invoice_no, invoice_date, grand_total, reason from invoices
     where against_invoice_id = ${id} and doc_type = 'credit_note' and status = 'issued' order by invoice_date`);
  const [against] = inv!.againstInvoiceId
    ? await rows(tx, sql`select id, invoice_no, invoice_date from invoices where id = ${inv!.againstInvoiceId}`)
    : [];
  const [order] = inv!.orderId ? await rows(tx, sql`select id, order_no from sales_orders where id = ${inv!.orderId}`) : [];
  // HSN-wise tax summary printed at the bottom of the invoice.
  const hsn_summary = await rows(tx, sql`
    select hsn_sac, gst_rate, sum(taxable_value) as taxable_value, sum(cgst) as cgst, sum(sgst) as sgst, sum(igst) as igst, sum(cess) as cess
      from invoice_lines where invoice_id = ${id} group by hsn_sac, gst_rate order by hsn_sac`);
  const company = await getCompany(tx, inv!.entityId);
  return {
    ...inv!,
    lines,
    hsn_summary,
    amount_in_words: amountInWords(inv!.grandTotal),
    place_of_supply_name: STATE_CODES[inv!.placeOfSupply] ?? inv!.placeOfSupply,
    is_inter_state: isInterState(company.state_code, inv!.placeOfSupply),
    is_b2b: Boolean(inv!.partyGstin),
    payment: outstanding ?? null,
    payments: paymentsMade,
    credit_notes: creditNotes,
    against_invoice: against ?? null,
    order: order ?? null,
    // A bill made when a vehicle was handed back from the workshop: its job card.
    job_card: (await rows(tx, sql`select id, job_no from job_cards where invoice_id = ${id}`))[0] ?? null,
    company,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const zLine = z.object({
  item_id: zId,
  qty: zQty,
  rate: emptyToNull(zMoney).optional(),
  discount: emptyToNull(zMoney).optional(),
  serials: zSerials.optional(),
});
const toLine = (l: z.infer<typeof zLine>): OrderLineInput => ({
  itemId: l.item_id, qty: l.qty, rate: l.rate ?? null, discount: l.discount ?? null, serials: l.serials ?? null,
});

const zDeliveryChecks = z.object({
  pdi_done: z.boolean().optional(), rider_briefing: z.boolean().optional(), warranty_registered: z.boolean().optional(),
  photo_file_id: emptyToNull(zId).optional(), signed_note_file_id: emptyToNull(zId).optional(),
});
const deliveryChecksIn = (b: z.infer<typeof zDeliveryChecks>): DeliveryChecksInput => ({
  pdiDone: b.pdi_done, riderBriefing: b.rider_briefing, warrantyRegistered: b.warranty_registered, photoFileId: b.photo_file_id, signedNoteFileId: b.signed_note_file_id,
});

export function salesRouter(db: DB) {
  const r = Router();

  // ---- quotes and orders ----
  r.get('/orders', requirePerm('sales:read'), async (req, res) => {
    const q = zListQuery.extend({
      status: z.enum(ORDER_STATUSES).optional(), channel: z.enum(CHANNELS).optional(), party_id: zId.optional(),
      from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select o.*, p.name as party_name,
             (select count(*)::int from sales_order_lines l where l.order_id = o.id) as line_count,
             (select coalesce(sum(l.qty * l.rate - l.discount), 0)::numeric(14,2) from sales_order_lines l where l.order_id = o.id) as line_amount
        from sales_orders o left join parties p on p.id = o.party_id
       where (${q.status ?? null}::text is null or o.status::text = ${q.status ?? null})
         and (${q.channel ?? null}::text is null or o.channel::text = ${q.channel ?? null})
         and (${q.party_id ?? null}::uuid is null or o.party_id = ${q.party_id ?? null}::uuid)
         and (${q.from ?? null}::date is null or o.order_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or o.order_date <= ${q.to ?? null}::date)
         and (${like}::text is null or o.order_no ilike ${like} or p.name ilike ${like})
       order by o.order_date desc, o.created_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'sales-orders', { limit: q.limit });
  });

  /** How many quotes and orders are at each status: the counters above the list. */
  r.get('/orders/summary', requirePerm('sales:read'), async (_req, res) => {
    const counts = await rows<{ status: string; n: number }>(db, sql`select status::text as status, count(*)::int as n from sales_orders group by status`);
    res.json({ data: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
  });

  r.get('/orders/:id', requirePerm('sales:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [order] = await db.select().from(salesOrders).where(eq(salesOrders.id, id));
    must(order, 'Sales order');
    const lines = await rows<TotalsLine & { gst_rate: string }>(db, sql`
      select l.*, i.sku, i.name as item_name, i.unit, i.hsn_sac, i.is_serialised
        from sales_order_lines l join items i on i.id = l.item_id where l.order_id = ${id} order by l.sort`);
    const { computed, totals } = await orderTotals(db, order!, lines.map((l: any) => ({ ...l, gstRate: l.gst_rate, cessRate: l.cess_rate })));
    const [party] = order!.partyId ? await db.select().from(parties).where(eq(parties.id, order!.partyId)) : [];
    // A draft's prices, checked as confirming would check them: who may confirm it can be shown up front.
    const priceChecks = order!.status === 'draft'
      ? await priceProblems(db, order!, lines.map((l: any) => ({ ...l, itemId: l.item_id, gstRate: l.gst_rate, cessRate: l.cess_rate })), req.user!.id)
      : [];
    res.json({
      data: {
        ...order,
        party: party ?? null,
        price_problems: priceChecks,
        lines: lines.map((l, i) => ({
          ...l, taxable_value: money(computed[i]!.taxableValue), cgst: money(computed[i]!.cgst), sgst: money(computed[i]!.sgst),
          igst: money(computed[i]!.igst), cess: money(computed[i]!.cess), line_total: money(computed[i]!.lineTotal),
        })),
        totals: {
          taxable_total: money(totals.taxableTotal), cgst_total: money(totals.cgstTotal), sgst_total: money(totals.sgstTotal),
          igst_total: money(totals.igstTotal), cess_total: money(totals.cessTotal), round_off: money(totals.roundOff), grand_total: money(totals.grandTotal),
        },
        deliveries: await rows(db, sql`
          select d.id, d.delivery_no, d.delivered_at, l.name as location from deliveries d join locations l on l.id = d.location_id
           where d.order_id = ${id} order by d.delivered_at`),
        invoices: await rows(db, sql`
          select id, doc_type, invoice_no, invoice_date, grand_total, status from invoices where order_id = ${id} order by created_at`),
        reservations: await reservationsOf(db, id),
        // A vehicle on the order: its delivery checklist, done before it is handed over.
        has_vehicle: (await rows(db, sql`select 1 from sales_order_lines l join items i on i.id = l.item_id where l.order_id = ${id} and i.item_type = 'vehicle' limit 1`)).length > 0,
        delivery_checks: (await db.select().from(deliveryChecks).where(eq(deliveryChecks.salesOrderId, id)))[0] ?? null,
        job_card: (await rows(db, sql`select id, job_no from job_cards where sales_order_id = ${id}`))[0] ?? null,
        company: await getCompany(db, order!.entityId),
      },
    });
  });

  const zOrder = z.object({
    channel: z.enum(CHANNELS).default('dealer'),
    entity_id: emptyToNull(zId).optional(),
    party_id: zId,
    lead_id: emptyToNull(zId).optional(),
    order_date: zDate.default(() => istDate()),
    place_of_supply: emptyToNull(zStateCode).optional(),
    tax_inclusive: z.boolean().nullish(),
    notes: emptyToNull(z.string().trim().max(2000)).optional(),
    lines: z.array(zLine).min(1).max(200),
  });

  /** Create a quote: a Draft sales order. */
  r.post('/orders', requirePerm('sales:write'), async (req, res) => {
    const b = zOrder.parse(req.body);
    const order = await inTx(db, req, (ctx) =>
      createOrder(ctx, {
        channel: b.channel, entityId: b.entity_id, partyId: b.party_id, leadId: b.lead_id, orderDate: b.order_date, placeOfSupply: b.place_of_supply,
        taxInclusive: b.tax_inclusive, notes: b.notes, lines: b.lines.map(toLine),
      }));
    res.status(201).json({ data: order });
  });

  /** Edit a quote. Only while Draft - a confirmed order is a commitment. */
  r.put('/orders/:id/lines', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ lines: z.array(zLine).min(1).max(200), notes: emptyToNull(z.string().trim().max(2000)).optional() }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const { order, lines: before } = await lockOrder(ctx.tx, id);
      if (order.status !== 'draft') throw conflict('Only a draft order can be edited');
      const party = await loadParty(ctx.tx, order.partyId);
      const { lines } = await buildLines(ctx.tx, party, b.lines.map(toLine), order.orderDate, order.taxInclusive);
      await ctx.tx.delete(salesOrderLines).where(eq(salesOrderLines.orderId, id));
      await ctx.tx.insert(salesOrderLines).values(lines.map((l) => ({ ...l, orderId: id })));
      if (b.notes !== undefined) await ctx.tx.update(salesOrders).set({ notes: b.notes, updatedAt: new Date() }).where(eq(salesOrders.id, id));
      await audit(ctx, 'sales_order', id, 'update_lines', before, lines);
    });
    res.json({ ok: true });
  });

  // The owner can confirm an order too: that is how a price below cost or over a seller's discount limit is approved.
  r.post('/orders/:id/confirm', requirePerm('sales:write', 'sales:approve_discount'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ override_credit: z.boolean().default(false) }).parse(req.body ?? {});
    if (b.override_credit && !can(req.user!.role, 'sales:override_credit')) throw forbidden('Only Accounts or the owner can override a credit limit');
    res.json({ data: await inTx(db, req, (ctx) => confirmOrder(ctx, id, { overrideCredit: b.override_credit })) });
  });

  r.post('/orders/:id/cancel', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => cancelOrder(ctx, id, b.reason)) });
  });

  r.post('/orders/:id/deliver', requirePerm('sales:write', 'stock:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      location_id: emptyToNull(zId).optional(),
      lines: z.array(z.object({ order_line_id: zId, qty: zQty, serials: zSerials.optional() })).min(1).optional(),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
    }).parse(req.body ?? {});
    const result = await inTx(db, req, (ctx) =>
      deliverOrder(ctx, id, {
        locationId: b.location_id, notes: b.notes,
        lines: b.lines?.map((l) => ({ orderLineId: l.order_line_id, qty: l.qty, serials: l.serials })),
      }));
    res.status(201).json({ data: result });
  });

  r.post('/orders/:id/invoice', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ invoice_date: zDate.optional(), notes: emptyToNull(z.string().trim().max(2000)).optional() }).parse(req.body ?? {});
    const invoice = await inTx(db, req, (ctx) => invoiceOrder(ctx, id, { invoiceDate: b.invoice_date, notes: b.notes }));
    res.status(201).json({ data: invoice });
  });

  r.get('/deliveries/:id', requirePerm('sales:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [delivery] = await rows(db, sql`
      select d.*, l.name as location, o.order_no, o.party_id, o.entity_id, p.name as party_name, p.phone as party_phone, p.gstin as party_gstin,
             p.shipping_address, p.billing_address
        from deliveries d join locations l on l.id = d.location_id join sales_orders o on o.id = d.order_id
        left join parties p on p.id = o.party_id where d.id = ${id}`);
    must(delivery, 'Delivery');
    const lines = await rows(db, sql`
      select dl.id, dl.qty, dl.serials, i.sku, i.name as item_name, i.unit, i.hsn_sac
        from delivery_lines dl join items i on i.id = dl.item_id where dl.delivery_id = ${id}`);
    res.json({ data: { ...delivery, lines, company: await getCompany(db, (delivery as any).entity_id) } });
  });

  // ---- quick bill ----
  /** Store quick bill - the whole sale in one request and one transaction (PRD 7.4). */
  /** The delivery checklist of an order with a vehicle on it: ticks, and the photo and signed note as files. */
  r.put('/orders/:id/delivery-checks', requirePerm('sales:write'), async (req, res) => {
    const b = zDeliveryChecks.parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => saveDeliveryChecks(ctx, zId.parse(req.params.id), deliveryChecksIn(b))) });
  });

  r.post('/quick-bill', requirePerm('quickbill:create'), async (req, res) => {
    const b = z.object({
      party_id: emptyToNull(zId).optional(),
      customer: z.object({ phone: zPhone, name: zText(150) }).nullish(),
      lines: z.array(zLine).min(1).max(100),
      payments: z.array(z.object({
        mode: z.enum(PAYMENT_MODES), amount: zMoneyPos, account_id: emptyToNull(zId).optional(),
        reference: emptyToNull(z.string().trim().max(100)).optional(),
      })).max(5).default([]),
      location_id: emptyToNull(zId).optional(),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
      override_credit: z.boolean().default(false),
      delivery_checks: zDeliveryChecks.nullish(),
    }).parse(req.body);
    if (b.override_credit && !can(req.user!.role, 'sales:override_credit')) throw forbidden('Only Accounts or the owner can override a credit limit');
    const result = await inTx(db, req, (ctx) =>
      quickBill(ctx, {
        partyId: b.party_id, customer: b.customer, lines: b.lines.map(toLine), locationId: b.location_id, notes: b.notes,
        overrideCredit: b.override_credit, deliveryChecks: b.delivery_checks ? deliveryChecksIn(b.delivery_checks) : null,
        payments: b.payments.map((p) => ({ mode: p.mode, amount: p.amount, accountId: p.account_id, reference: p.reference })),
      }));
    res.status(201).json({ data: result });
  });

  /** Price + tax preview for the bill being built (no data is saved). */
  r.post('/price-preview', requirePerm('sales:read', 'quickbill:create'), async (req, res) => {
    const b = z.object({ party_id: emptyToNull(zId).optional(), lines: z.array(zLine).min(1).max(200),
      tax_inclusive: z.boolean().nullish(), place_of_supply: emptyToNull(zStateCode).optional() }).parse(req.body);
    const party = await loadParty(db, b.party_id ?? null);
    const company = await getCompany(db);
    const { lines, taxInclusive } = await buildLines(db, party, b.lines.map(toLine), istDate(), b.tax_inclusive);
    const pos = b.place_of_supply ?? party?.stateCode ?? company.state_code;
    const inter = isInterState(company.state_code, pos);
    const computed = lines.map((l) => computeLine(l, inter, taxInclusive));
    const totals = computeTotals(computed);
    // What confirming would say about the prices, as this user would make the bill, so the screen can warn before saving.
    const asIfOrder = { partyId: party?.id ?? null, createdBy: req.user!.id, placeOfSupply: pos, taxInclusive } as Order;
    const priceChecks = await priceProblems(db, asIfOrder, lines, req.user!.id);
    res.json({
      data: {
        tax_inclusive: taxInclusive, place_of_supply: pos, is_inter_state: inter, price_problems: priceChecks,
        lines: lines.map((l, i) => ({
          item_id: l.itemId, qty: l.qty, rate: l.rate, discount: l.discount, gst_rate: l.gstRate, cess_rate: l.cessRate,
          taxable_value: money(computed[i]!.taxableValue), cgst: money(computed[i]!.cgst), sgst: money(computed[i]!.sgst),
          igst: money(computed[i]!.igst), cess: money(computed[i]!.cess), line_total: money(computed[i]!.lineTotal),
        })),
        totals: {
          taxable_total: money(totals.taxableTotal), cgst_total: money(totals.cgstTotal), sgst_total: money(totals.sgstTotal),
          igst_total: money(totals.igstTotal), cess_total: money(totals.cessTotal), round_off: money(totals.roundOff), grand_total: money(totals.grandTotal),
        },
      },
    });
  });

  // ---- invoices & credit notes ----
  r.get('/invoices', requirePerm('invoices:read'), async (req, res) => {
    const q = zListQuery.extend({
      doc_type: z.enum(['tax_invoice', 'credit_note']).optional(), status: z.enum(['draft', 'issued', 'cancelled']).optional(),
      payment_status: z.enum(['unpaid', 'partly_paid', 'paid']).optional(), party_id: zId.optional(), channel: z.enum(CHANNELS).optional(),
      from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select i.id, i.doc_type, i.invoice_no, i.fy, i.invoice_date, i.due_date, i.party_id, i.party_name, i.party_gstin, i.channel,
             i.place_of_supply, i.taxable_total, i.cgst_total, i.sgst_total, i.igst_total, i.round_off, i.grand_total, i.status,
             o.outstanding, o.payment_status,
             case when o.outstanding > 0 and i.due_date < (now() at time zone 'Asia/Kolkata')::date then (now() at time zone 'Asia/Kolkata')::date - i.due_date else 0 end as days_overdue
        from invoices i left join v_invoice_outstanding o on o.invoice_id = i.id
       where i.status <> 'draft'
         and (${q.doc_type ?? null}::text is null or i.doc_type::text = ${q.doc_type ?? null})
         and (${q.status ?? null}::text is null or i.status::text = ${q.status ?? null})
         and (${q.payment_status ?? null}::text is null or o.payment_status = ${q.payment_status ?? null})
         and (${q.party_id ?? null}::uuid is null or i.party_id = ${q.party_id ?? null}::uuid)
         and (${q.channel ?? null}::text is null or i.channel::text = ${q.channel ?? null})
         and (${q.from ?? null}::date is null or i.invoice_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or i.invoice_date <= ${q.to ?? null}::date)
         and (${like}::text is null or i.invoice_no ilike ${like} or i.party_name ilike ${like})
       order by i.invoice_date desc, i.issued_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'invoices', { limit: q.limit });
  });

  r.get('/invoices/:id', requirePerm('invoices:read'), async (req, res) => {
    res.json({ data: await invoiceDocument(db, zId.parse(req.params.id)) });
  });

  /** The link the customer opens to see this bill. Made once; the same link every time after. */
  r.post('/invoices/:id/share', requirePerm('invoices:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const token = await inTx(db, req, (ctx) => shareTokenFor(ctx, id));
    res.json({ data: { token, path: `/i/${token}` } });
  });

  r.post('/invoices/:id/credit-note', requirePerm('invoices:adjust'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      lines: z.array(z.object({ invoice_line_id: zId, qty: zQty, serials: zSerials.optional() })).min(1),
      restock: z.boolean().default(true),
      location_id: emptyToNull(zId).optional(),
      reason: zText(500),
      date: zDate.optional(),
    }).parse(req.body);
    const cn = await inTx(db, req, (ctx) =>
      createCreditNote(ctx, id, {
        lines: b.lines.map((l) => ({ invoiceLineId: l.invoice_line_id, qty: l.qty, serials: l.serials })), restock: b.restock,
        locationId: b.location_id, reason: b.reason, date: b.date,
      }));
    res.status(201).json({ data: cn });
  });

  /** Credit notes and this invoice: what has been set against it, what could be, and where a credit note's credit went. */
  r.get('/invoices/:id/credits', requirePerm('invoices:read'), async (req, res) => {
    res.json({ data: await creditsFor(db, zId.parse(req.params.id)) });
  });

  r.post('/invoices/:id/apply-credit', requirePerm('invoices:adjust', 'payments:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ credit_note_id: zId, amount: emptyToNull(zMoneyPos).optional() }).parse(req.body);
    res.status(201).json({ data: await inTx(db, req, (ctx) => applyCredit(ctx, id, b.credit_note_id, b.amount)) });
  });

  r.post('/credit-applications/:id/take-back', requirePerm('invoices:adjust', 'payments:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, (ctx) => unapplyCredit(ctx, id, 'Taken back by hand'));
    res.json({ ok: true });
  });

  /**
   * Record the e-invoice (IRN) and e-way bill references for an issued invoice or credit note, as the
   * GST portal gave them (a GSP connection will fill these by itself later). Nothing else can change.
   */
  r.put('/invoices/:id/e-invoice', requirePerm('invoices:adjust'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const stamp = emptyToNull(z.string().datetime({ offset: true })).optional();
    const b = z.object({
      irn: emptyToNull(z.string().trim().regex(/^[0-9a-f]{64}$/i, 'an IRN is 64 hexadecimal characters')).optional(),
      irn_ack_no: emptyToNull(z.string().trim().max(30)).optional(), irn_ack_date: stamp,
      signed_qr: emptyToNull(z.string().trim().max(5000)).optional(),
      irn_status: emptyToNull(z.enum(['generated', 'cancelled', 'failed'])).optional(), irn_cancelled_at: stamp,
      eway_bill_no: emptyToNull(z.string().trim().regex(/^\d{12}$/, 'an e-way bill number is 12 digits')).optional(), eway_valid_until: stamp,
    }).parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [inv] = await ctx.tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
      must(inv, 'Invoice');
      if (inv!.status === 'draft') throw conflict('Issue the invoice first');
      const patch = {
        ...(b.irn !== undefined ? { irn: b.irn?.toLowerCase() ?? null } : {}), ...(b.irn_ack_no !== undefined ? { irnAckNo: b.irn_ack_no } : {}),
        ...(b.irn_ack_date !== undefined ? { irnAckDate: b.irn_ack_date ? new Date(b.irn_ack_date) : null } : {}),
        ...(b.signed_qr !== undefined ? { signedQr: b.signed_qr } : {}), ...(b.irn_status !== undefined ? { irnStatus: b.irn_status } : {}),
        ...(b.irn_cancelled_at !== undefined ? { irnCancelledAt: b.irn_cancelled_at ? new Date(b.irn_cancelled_at) : null } : {}),
        ...(b.eway_bill_no !== undefined ? { ewayBillNo: b.eway_bill_no } : {}),
        ...(b.eway_valid_until !== undefined ? { ewayValidUntil: b.eway_valid_until ? new Date(b.eway_valid_until) : null } : {}),
      };
      const [row] = await ctx.tx.update(invoices).set({ ...patch, updatedAt: new Date() }).where(eq(invoices.id, id)).returning();
      await audit(ctx, 'invoice', id, 'e_invoice', null, patch);
      return row;
    });
    res.json({ data: updated });
  });

  r.post('/invoices/:id/cancel', requirePerm('invoices:adjust'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500), restock: z.boolean().default(false), cancel_payments: z.boolean().default(false) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => cancelInvoice(ctx, id, { reason: b.reason, restock: b.restock, cancelPayments: b.cancel_payments })) });
  });
  return r;
}
