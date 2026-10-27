import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  round2, D, LANDED_COST_KINDS, OUTSIDE_INDIA, PO_STATUSES, ROLES, can, addDays, computeLine, computeTotals, isInterState, istDate, money, qty as fmtQty,
  type LandedCostKind, type LineTax,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal, reverseJournals, type JLine } from '../core/journal';
import { nextNumber } from '../core/numbering';
import { getCompany } from '../core/settings';
import { assertGstOpen } from '../core/gst-lock';
import { locationByType, lockItems, stockIn, stockOut } from '../core/stock';
import { taxRateOn } from '../core/taxrates';
import { batchFor, cleanSerials, needsSerials, unitsIn } from '../core/units';
import { rows, type DB } from '../db/client';
import {
  goodsReceiptLines, goodsReceipts, importShipments, poApprovalLimits, items, jobWorks, landedCostLines, parties, purchaseBillLines, purchaseBills, purchaseOrderLines,
  purchaseOrders, purchaseReturnLines, purchaseReturns,
} from '../db/schema';
import { assertOnce, badRequest, conflict, must } from '../lib/errors';
import {
  emptyToNull, fxOf, inTx, sendList, zCurrency, zDate, zFxRate, zId, zListQuery, zMoney, zQty, zQtyNonNeg, zSerials, zSignedMoney, zText, type Ctx,
} from '../lib/http';

import { chargeState } from './jobwork';

/**
 * Buying, from the order to the supplier's bill.
 *
 *   purchase order -> goods received -> quality check -> purchase bill -> payment (payments.ts)
 *                                            '-> rejected goods -> supplier return + debit note
 *
 * Goods enter stock at the quality check, not when they are counted in: accepted goods go to
 * Stores and rejected ones to the Rejected place, both at the order rate, against Goods Received
 * Not Billed. The bill later clears that account and sets up what is owed to the supplier.
 * A bill can also be for a service with no order behind it, such as a job worker's charge.
 */

type PO = typeof purchaseOrders.$inferSelect;
type Bill = typeof purchaseBills.$inferSelect;

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------
async function loadSupplier(tx: DB, id: string) {
  const [s] = await tx.select().from(parties).where(eq(parties.id, id));
  if (!s) throw badRequest('Supplier not found');
  if (s.partyType !== 'supplier') throw badRequest(`${s.name} is not a supplier`);
  return s;
}

type PoLineInput = { itemId: string; qty: string; rate?: string | null };

/**
 * Buying from outside India (a supplier whose state is "Outside India", or a document in a foreign currency) is an
 * import. The supplier's invoice carries no Indian GST, so none is charged on its PO, bill or debit note and none
 * is claimed from it (technical review, 26 Oct 2026: bills from foreign suppliers were claiming GST credit). The
 * IGST on imported goods is paid at customs and claimed there, on the import shipment (modules/imports.ts).
 * Services bought from abroad owe GST under reverse charge, which is not handled yet.
 */
const isImport = (supplier: { stateCode: string | null }, currency: string) => supplier.stateCode === OUTSIDE_INDIA || currency !== 'INR';

/**
 * PO lines, at the GST rate in force on the PO date (core/taxrates.ts). A PO in a foreign currency
 * gives its rates in that currency; they are kept in rupees at the PO's rate.
 */
async function buildPoLines(tx: DB, input: PoLineInput[], date: string, fxRate: string = '1', noGst = false) {
  if (input.length === 0) throw badRequest('Add at least one item');
  const found = await tx.select().from(items).where(inArray(items.id, [...new Set(input.map((l) => l.itemId))]));
  const byId = new Map(found.map((i) => [i.id, i]));
  const lines = [];
  for (const [idx, l] of input.entries()) {
    const item = byId.get(l.itemId);
    if (!item) throw badRequest('Item not found');
    // Goods come in through the PO -> inward flow; services are booked as a bill or expense.
    if (!item.isStockItem) throw badRequest(`${item.name} is a service. Purchase orders are for goods.`);
    const gstRate = noGst ? '0' : (await taxRateOn(tx, item, date)).gstRate;
    const rate = l.rate != null ? round2(D(l.rate).times(fxRate)) : D(item.purchaseCost);
    lines.push({ itemId: item.id, qty: fmtQty(l.qty), rate: money(rate), gstRate, sort: idx });
  }
  return lines;
}

/** Purchase order: supplier, items, quantity, rate, expected date. No indents, no approval chain (PRD 7.7). */
export async function createPurchaseOrder(
  ctx: Ctx,
  input: {
    supplierId: string; orderDate: string; expectedDate?: string | null; notes?: string | null; lines: PoLineInput[];
    currency?: string; fxRate?: string | null;
  },
): Promise<PO> {
  const { tx } = ctx;
  const supplier = await loadSupplier(tx, input.supplierId);
  const fx = fxOf(input.currency ?? 'INR', input.fxRate);
  const lines = await buildPoLines(tx, input.lines, input.orderDate, fx.fxRate, isImport(supplier, fx.currency));
  const { number } = await nextNumber(tx, 'purchase_order', input.orderDate);
  const [po] = await tx
    .insert(purchaseOrders)
    .values({
      poNo: number, supplierId: input.supplierId, orderDate: input.orderDate, expectedDate: input.expectedDate ?? null,
      currency: fx.currency, fxRate: fx.fxRate, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await tx.insert(purchaseOrderLines).values(lines.map((l) => ({ ...l, purchaseOrderId: po!.id })));
  await audit(ctx, 'purchase_order', po!.id, 'create', null, { ...po, lines });
  return po!;
}

async function setPoStatus(ctx: Ctx, po: PO, status: PO['status'], extra: object = {}): Promise<PO> {
  if (po.status === status) return po;
  const [updated] = await ctx.tx.update(purchaseOrders).set({ status, updatedAt: new Date() }).where(eq(purchaseOrders.id, po.id)).returning();
  await audit(ctx, 'purchase_order', po.id, 'status_change', { status: po.status }, { status, ...extra });
  return updated!;
}

/** What a PO comes to with GST, in rupees: what its approval limit is measured against. */
async function poTotal(tx: DB, poId: string) {
  const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
  return computeTotals(lines.map((l) => computeLine({ qty: l.qty, rate: l.rate, gstRate: l.gstRate }, false, false)), false).grandTotal;
}

async function refreshPoStatus(ctx: Ctx, poId: string): Promise<void> {
  const [po] = await ctx.tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update');
  if (!po || !['sent', 'partly_received', 'received'].includes(po.status)) return;
  const lines = await ctx.tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
  const any = lines.some((l) => D(l.receivedQty).gt(0));
  const all = lines.every((l) => D(l.receivedQty).gte(l.qty));
  await setPoStatus(ctx, po, all ? 'received' : any ? 'partly_received' : 'sent');
}

// ---------------------------------------------------------------------------
// Goods received and the quality check
// ---------------------------------------------------------------------------
/**
 * Goods received (PRD 6.2): counted at stores, waiting for QC. NOT in stock yet -
 * nothing is posted to the stock ledger until the QC split is recorded.
 */
export async function createGoodsReceipt(
  ctx: Ctx,
  input: { purchaseOrderId: string; notes?: string | null; lines: { poLineId: string; receivedQty: string }[] },
) {
  const { tx } = ctx;
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).for('update');
  must(po, 'Purchase order');
  if (!['sent', 'partly_received'].includes(po!.status)) {
    throw conflict(`PO ${po!.poNo} is ${po!.status.replace('_', ' ')}. Goods can only be received against a sent PO.`);
  }
  if (input.lines.length === 0) throw badRequest('Enter the quantity received for at least one item');
  assertOnce(input.lines, (l) => l.poLineId, 'PO line');
  const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po!.id));
  const { number } = await nextNumber(tx, 'goods_receipt', istDate());
  const [grn] = await tx
    .insert(goodsReceipts)
    .values({ grnNo: number, supplierId: po!.supplierId, purchaseOrderId: po!.id, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null })
    .returning();
  for (const l of input.lines) {
    const pol = poLines.find((p) => p.id === l.poLineId);
    if (!pol) throw badRequest('Line does not belong to this purchase order');
    const total = D(pol.receivedQty).plus(l.receivedQty);
    if (total.gt(pol.qty)) {
      throw conflict(`Receiving ${fmtQty(l.receivedQty)} would exceed the ordered quantity (${fmtQty(D(pol.qty).minus(pol.receivedQty))} still pending). Raise the PO quantity first.`);
    }
    await tx.insert(goodsReceiptLines).values({
      grnId: grn!.id, poLineId: pol.id, itemId: pol.itemId, receivedQty: fmtQty(l.receivedQty), rate: pol.rate,
    });
    await tx.update(purchaseOrderLines).set({ receivedQty: fmtQty(total) }).where(eq(purchaseOrderLines.id, pol.id));
  }
  await refreshPoStatus(ctx, po!.id);
  await audit(ctx, 'goods_receipt', grn!.id, 'create', null, { ...grn, lines: input.lines });
  return grn!;
}

/** The QC result for one receipt line. A serialised item needs one serial per accepted unit; a batch number is optional. */
export type QcLine = {
  grnLineId: string; acceptedQty: string; rejectedQty: string; rejectReason?: string | null;
  serials?: string[] | null;
  batch?: { batchNo: string; mfgDate?: string | null; chemistry?: string | null; weightKg?: string | null } | null;
};

/**
 * QC check + inward (PRD 6.2 / 7.7), in one transaction:
 * - each line splits into accepted + rejected (= received), with a reason for rejects
 * - accepted quantity enters Stores at the PO rate; rejected goes to the Rejected location
 * - a serialised item's accepted units are each given their serial here (rejected ones are not:
 *   they go back to the supplier as a quantity); a batch number, if given, follows the stock
 * - Dr Stock in Hand / Cr Goods Received Not Billed for the goods now held
 */
export async function qcGoodsReceipt(ctx: Ctx, grnId: string, input: { lines: QcLine[] }) {
  const { tx } = ctx;
  const [grn] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, grnId)).for('update');
  must(grn, 'Goods receipt');
  if (grn!.status !== 'received') throw conflict(`${grn!.grnNo} is already ${grn!.status}`);
  const lines = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.grnId, grnId));
  if (input.lines.length !== lines.length || !lines.every((l) => input.lines.some((x) => x.grnLineId === l.id))) {
    throw badRequest('Record the QC result for every line of the receipt');
  }
  const storesId = await locationByType(tx, 'stores');
  const rejectedId = await locationByType(tx, 'rejected');
  const itemById = new Map((await lockItems(tx, lines.map((l) => l.itemId))).map((i) => [i.id, i]));
  const today = istDate();
  const now = new Date();
  let value = D(0);
  for (const line of lines) {
    const item = itemById.get(line.itemId)!;
    const qc = input.lines.find((x) => x.grnLineId === line.id)!;
    const accepted = D(qc.acceptedQty);
    const rejected = D(qc.rejectedQty);
    if (!accepted.plus(rejected).eq(line.receivedQty)) {
      throw badRequest(`Accepted + rejected must equal the ${fmtQty(line.receivedQty)} received`);
    }
    const reason = qc.rejectReason?.trim() || null;
    if (rejected.gt(0) && !reason) throw badRequest('Give a reason for the rejected quantity');
    const serials = needsSerials(item) ? cleanSerials(item, accepted, qc.serials) : null;
    if (!needsSerials(item) && qc.serials?.length) throw badRequest(`${item.name} is not kept by serial number`);
    const batchId = qc.batch?.batchNo?.trim() ? await batchFor(ctx, item.id, { ...qc.batch, supplierId: grn!.supplierId }) : null;
    await tx
      .update(goodsReceiptLines)
      .set({ acceptedQty: fmtQty(accepted), rejectedQty: fmtQty(rejected), rejectReason: rejected.gt(0) ? reason : null, qcBy: ctx.user?.id ?? null, qcAt: now, batchId })
      .where(eq(goodsReceiptLines.id, line.id));
    if (accepted.gt(0)) {
      value = value.plus(serials
        ? await unitsIn(ctx, {
            item, locationId: storesId, serials, unitCost: line.rate, movementType: 'purchase_in', refType: 'goods_receipt', refId: grnId,
            event: 'received', batchId, mfgDate: qc.batch?.mfgDate ?? null,
          })
        : await stockIn(ctx, {
            itemId: line.itemId, locationId: storesId, qty: accepted, unitCost: line.rate, movementType: 'purchase_in',
            refType: 'goods_receipt', refId: grnId, batchId,
          }));
      // Last purchase cost follows the latest inward.
      await tx.update(items).set({ purchaseCost: line.rate, updatedAt: now }).where(eq(items.id, line.itemId));
    }
    if (rejected.gt(0)) {
      value = value.plus(await stockIn(ctx, {
        itemId: line.itemId, locationId: rejectedId, qty: rejected, unitCost: line.rate, movementType: 'purchase_in',
        refType: 'goods_receipt', refId: grnId, reason: `QC rejected: ${reason}`, batchId,
      }));
    }
  }
  const [updated] = await tx.update(goodsReceipts).set({ status: 'inwarded', updatedAt: now }).where(eq(goodsReceipts.id, grnId)).returning();
  await postJournal(ctx, {
    date: today, refType: 'goods_receipt', refId: grnId, narration: `Goods inwarded, ${grn!.grnNo}`,
    lines: [{ account: 'stock', debit: value }, { account: 'grni', credit: value }],
  });
  await audit(ctx, 'goods_receipt', grnId, 'qc_inward', { status: 'received' }, { status: 'inwarded', lines: input.lines });
  return updated!;
}

// ---------------------------------------------------------------------------
// Purchase bills
// ---------------------------------------------------------------------------
export type BillLineInput = {
  poLineId?: string | null; itemId?: string | null; qty: string; rate: string; description?: string | null;
  /** On a bill for an import shipment: what kind of landed cost this service line is (freight, cha, port...). */
  landedKind?: LandedCostKind | null;
};

/**
 * Supplier invoice (purchase bill). Posts Dr Goods-Received-Not-Billed (or Purchases for
 * services) - Dr Input GST - Cr Creditors, and flags quantity/rate mismatches against the
 * PO and what stores actually accepted (PRD 7.7).
 */
export async function createPurchaseBill(
  ctx: Ctx,
  input: {
    supplierId: string; purchaseOrderId?: string | null; supplierInvoiceNo: string; billDate: string; dueDate?: string | null;
    roundOff?: string | null; notes?: string | null; lines: BillLineInput[];
    /** A bill in a foreign currency: its rates are in that currency and are kept in rupees at this rate. */
    currency?: string; fxRate?: string | null;
    /** The job work challan this bill is the job worker's charge for. */
    jobWorkId?: string | null;
    /** The import shipment this bill (a forwarder's, a customs agent's) is a cost of landing. */
    importShipmentId?: string | null;
  },
): Promise<Bill> {
  const { tx } = ctx;
  const supplier = await loadSupplier(tx, input.supplierId);
  const company = await getCompany(tx);
  if (input.lines.length === 0) throw badRequest('Add at least one line');
  let poLines: (typeof purchaseOrderLines.$inferSelect)[] = [];
  if (input.purchaseOrderId) {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).for('update');
    must(po, 'Purchase order');
    if (po!.supplierId !== supplier.id) throw badRequest('That purchase order is for a different supplier');
    if (['draft', 'cancelled', 'pending_approval'].includes(po!.status)) throw conflict(`PO ${po!.poNo} is ${po!.status.replace('_', ' ')}`);
    poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po!.id));
  }
  // Supplier in another state charges IGST; same state charges CGST + SGST.
  const inter = isInterState(company.state_code, supplier.stateCode ?? company.state_code);

  const fx = fxOf(input.currency ?? 'INR', input.fxRate);
  const imported = isImport(supplier, fx.currency);
  await assertGstOpen(tx, input.billDate, 'purchases', 'no bill can be dated in it');
  const resolved = input.lines.map((l) => {
    const pol = l.poLineId ? poLines.find((p) => p.id === l.poLineId) : undefined;
    if (l.poLineId && !pol) throw badRequest('A bill line points to a PO line that is not on this purchase order');
    const itemId = pol?.itemId ?? l.itemId;
    if (!itemId) throw badRequest('Each bill line needs an item');
    return { ...l, rate: money(round2(D(l.rate).times(fx.fxRate))), itemId, pol };
  });
  const itemRows = await tx.select().from(items).where(inArray(items.id, [...new Set(resolved.map((l) => l.itemId))]));
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  const mismatches: { item: string; type: string; expected: string; actual: string }[] = [];
  const computed: LineTax[] = [];
  const lineRows: (typeof purchaseBillLines.$inferInsert)[] = [];
  let stockTaxable = D(0);
  let serviceTaxable = D(0);
  for (const [idx, l] of resolved.entries()) {
    const item = itemById.get(l.itemId);
    if (!item) throw badRequest('Item not found');
    if (item.isStockItem && !l.pol) throw badRequest(`${item.name} is a stock item: bill it against its purchase order line`);
    const gstRate = imported ? '0' : (l.pol?.gstRate ?? item.gstRate);
    const tax = computeLine({ qty: l.qty, rate: l.rate, gstRate }, inter, false);
    computed.push(tax);
    if (item.isStockItem) stockTaxable = stockTaxable.plus(tax.taxableValue);
    else serviceTaxable = serviceTaxable.plus(tax.taxableValue);
    lineRows.push({
      billId: '', poLineId: l.pol?.id ?? null, itemId: item.id, description: l.description ?? item.name, hsnSac: item.hsnSac,
      qty: fmtQty(l.qty), rate: money(l.rate), taxableValue: money(tax.taxableValue), gstRate,
      cgst: money(tax.cgst), sgst: money(tax.sgst), igst: money(tax.igst), lineTotal: money(tax.lineTotal), sort: idx,
    });
    if (l.pol) {
      if (!D(l.rate).eq(l.pol.rate)) mismatches.push({ item: item.name, type: 'rate_vs_po', expected: l.pol.rate, actual: money(l.rate) });
      const [prev] = await rows<{ q: string }>(tx, sql`
        select coalesce(sum(bl.qty), 0)::text as q from purchase_bill_lines bl join purchase_bills b on b.id = bl.bill_id
         where bl.po_line_id = ${l.pol.id} and b.doc_type = 'bill' and b.status = 'posted'`);
      const billed = D(prev?.q ?? 0).plus(l.qty);
      if (billed.gt(l.pol.qty)) mismatches.push({ item: item.name, type: 'qty_billed_over_po', expected: l.pol.qty, actual: fmtQty(billed) });
      const [rec] = await rows<{ received: string; accepted: string | null }>(tx, sql`
        select coalesce(sum(gl.received_qty), 0)::text as received, sum(gl.accepted_qty)::text as accepted
          from goods_receipt_lines gl join goods_receipts g on g.id = gl.grn_id
         where gl.po_line_id = ${l.pol.id} and g.status <> 'cancelled'`);
      if (D(rec?.received ?? 0).gt(0) && !billed.eq(rec!.received)) {
        mismatches.push({ item: item.name, type: 'qty_billed_vs_received', expected: fmtQty(rec!.received), actual: fmtQty(billed) });
      }
    }
  }

  const totals = computeTotals(computed, false);
  const roundOff = D(input.roundOff ?? 0);
  if (roundOff.abs().gt(10)) throw badRequest('Round-off on a supplier bill cannot be more than 10 rupees');
  const grand = totals.grandTotal.plus(roundOff);

  // A job worker's bill first settles the charges that were added to the cost of the goods when they came
  // back (they are already in stock, so they must not be expensed again); anything beyond that is an expense.
  let jobWorkCleared = D(0);
  if (input.jobWorkId) {
    const [job] = await tx.select().from(jobWorks).where(eq(jobWorks.id, input.jobWorkId)).for('update');
    must(job, 'Job work challan');
    if (job!.jobWorkerId !== supplier.id) throw badRequest(`Challan ${job!.challanNo} was sent to a different job worker`);
    if (job!.status === 'cancelled') throw conflict(`Challan ${job!.challanNo} is cancelled`);
    const c = await chargeState(tx, job!.id);
    const open = c.added.minus(c.billed);
    jobWorkCleared = open.lte(0) ? D(0) : serviceTaxable.lt(open) ? serviceTaxable : open;
  }

  // A forwarder's or customs agent's bill for an import: its service lines are that shipment's landed cost, so
  // they go to Landed Costs Clearing (and from there onto the goods), not to Purchases.
  if (input.importShipmentId) {
    const [shipment] = await tx.select().from(importShipments).where(eq(importShipments.id, input.importShipmentId)).for('update');
    must(shipment, 'Import shipment');
    if (input.jobWorkId) throw badRequest('A bill is for a job work challan or for an import shipment, not both');
    if (serviceTaxable.lte(0)) throw badRequest('A bill for an import shipment needs at least one service line (freight, clearing, port charges)');
  }
  const landedCleared = input.importShipmentId ? serviceTaxable : D(0);

  const { number, fy } = await nextNumber(tx, 'purchase_bill', input.billDate);
  const [bill] = await tx
    .insert(purchaseBills)
    .values({
      docType: 'bill', billNo: number, fy, supplierInvoiceNo: input.supplierInvoiceNo, billDate: input.billDate,
      dueDate: input.dueDate ?? addDays(input.billDate, supplier.paymentTermsDays ?? 0), supplierId: supplier.id,
      purchaseOrderId: input.purchaseOrderId ?? null, placeOfSupply: company.state_code, currency: fx.currency, fxRate: fx.fxRate,
      taxableTotal: money(totals.taxableTotal), cgstTotal: money(totals.cgstTotal), sgstTotal: money(totals.sgstTotal),
      igstTotal: money(totals.igstTotal), roundOff: money(roundOff), grandTotal: money(grand),
      mismatches: mismatches.length ? mismatches : null, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null,
      jobWorkId: input.jobWorkId ?? null, jobWorkCleared: money(jobWorkCleared), importShipmentId: input.importShipmentId ?? null,
    })
    .returning();
  await tx.insert(purchaseBillLines).values(lineRows.map((l) => ({ ...l, billId: bill!.id })));
  if (input.importShipmentId) {
    const costs = resolved.map((l, idx) => ({ l, idx, item: itemById.get(l.itemId)! })).filter((x) => !x.item.isStockItem);
    await tx.insert(landedCostLines).values(costs.map((x) => ({
      shipmentId: input.importShipmentId!, kind: x.l.landedKind ?? 'other', description: x.l.description ?? x.item.name,
      amount: money(computed[x.idx]!.taxableValue), purchaseBillId: bill!.id, createdBy: ctx.user?.id ?? null,
    })));
  }

  await postJournal(ctx, {
    date: input.billDate,
    refType: 'purchase_bill',
    refId: bill!.id,
    narration: `Purchase bill ${input.supplierInvoiceNo} from ${supplier.name} (${number})`,
    lines: [
      { account: 'grni', debit: stockTaxable },
      { account: 'job_work_accrued', partyId: supplier.id, debit: jobWorkCleared },
      { account: 'landed_cost_clearing', debit: landedCleared },
      { account: 'purchases', debit: serviceTaxable.minus(jobWorkCleared).minus(landedCleared) },
      { account: 'input_cgst', debit: totals.cgstTotal },
      { account: 'input_sgst', debit: totals.sgstTotal },
      { account: 'input_igst', debit: totals.igstTotal },
      { account: 'round_off', debit: roundOff },
      { account: 'creditors', partyId: supplier.id, credit: grand },
    ],
  });
  await audit(ctx, 'purchase_bill', bill!.id, 'create', null, bill);
  return bill!;
}

/** Cancel a bill entered wrongly: its entry is reversed. Refused while a payment or a debit note stands against it. */
export async function cancelPurchaseBill(ctx: Ctx, id: string, reason: string): Promise<Bill> {
  const { tx } = ctx;
  const [bill] = await tx.select().from(purchaseBills).where(eq(purchaseBills.id, id)).for('update');
  must(bill, 'Purchase bill');
  if (bill!.status !== 'posted') throw conflict('Bill is already cancelled');
  if (bill!.docType !== 'bill') throw conflict('A debit note is cancelled by reversing its supplier return');
  // Already in a filed GSTR-3B: cancelling would take back input tax that return claimed.
  await assertGstOpen(tx, bill!.billDate, 'purchases', `${bill!.billNo} cannot be cancelled`);
  const [o] = await rows<{ allocated: string; debited: string }>(tx, sql`select allocated::text, debited::text from v_bill_outstanding where bill_id = ${id}`);
  if (D(o?.allocated ?? 0).gt(0)) throw conflict('Payments are allocated to this bill. Cancel them first.');
  if (D(o?.debited ?? 0).gt(0)) throw conflict('This bill has a debit note against it and cannot be cancelled');
  // A shipment's costs from this bill go with it, unless they are already on the goods.
  const [applied] = await tx.select({ id: landedCostLines.id }).from(landedCostLines)
    .where(and(eq(landedCostLines.purchaseBillId, id), isNotNull(landedCostLines.applicationId))).limit(1);
  if (applied) throw conflict('The costs on this bill are already on the goods of its import shipment, so it cannot be cancelled');
  await tx.delete(landedCostLines).where(eq(landedCostLines.purchaseBillId, id));
  const [updated] = await tx.update(purchaseBills).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(purchaseBills.id, id)).returning();
  await reverseJournals(ctx, 'purchase_bill', id, istDate(), `Cancelled bill ${bill!.billNo}: ${reason}`);
  await audit(ctx, 'purchase_bill', id, 'cancel', { status: 'posted' }, { status: 'cancelled', reason });
  return updated!;
}

// ---------------------------------------------------------------------------
// Supplier returns (debit notes)
// ---------------------------------------------------------------------------
/**
 * Supplier return (PRD 7.7): one action on the rejected lines sends the stock out of the
 * Rejected location and raises a debit note against the supplier's bill
 * (Dr Creditors - Cr Stock - Cr Input GST).
 */
export async function createSupplierReturn(
  ctx: Ctx,
  grnId: string,
  input: { lines?: { grnLineId: string; qty: string }[]; notes?: string | null; date?: string },
) {
  const { tx } = ctx;
  const [grn] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, grnId)).for('update');
  must(grn, 'Goods receipt');
  if (grn!.status !== 'inwarded') throw conflict('QC must be recorded before rejects can be returned');
  if (input.lines) assertOnce(input.lines, (l) => l.grnLineId, 'received line');
  const grnLines = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.grnId, grnId));
  const want = (input.lines
    ? input.lines.map((l) => {
        const line = grnLines.find((g) => g.id === l.grnLineId);
        if (!line) throw badRequest('Line does not belong to this receipt');
        return { line, qty: D(l.qty) };
      })
    : grnLines.map((line) => ({ line, qty: D(line.rejectedQty ?? 0).minus(line.returnedQty) }))
  ).filter((w) => w.qty.gt(0));
  if (want.length === 0) throw conflict('There are no rejected goods waiting to be returned on this receipt');
  for (const w of want) {
    if (w.qty.gt(D(w.line.rejectedQty ?? 0).minus(w.line.returnedQty))) throw conflict('Cannot return more than the rejected quantity still held');
  }

  // The debit note is raised against the supplier's bill for this PO.
  const [bill] = await tx
    .select()
    .from(purchaseBills)
    .where(and(eq(purchaseBills.purchaseOrderId, grn!.purchaseOrderId), eq(purchaseBills.docType, 'bill'), eq(purchaseBills.status, 'posted')))
    .orderBy(desc(purchaseBills.billDate), desc(purchaseBills.createdAt))
    .limit(1);
  if (!bill) throw conflict('Record the supplier invoice for this PO first: the debit note is raised against it.');

  const supplier = await loadSupplier(tx, grn!.supplierId);
  const company = await getCompany(tx);
  const inter = isInterState(company.state_code, supplier.stateCode ?? company.state_code);
  const date = input.date ?? istDate();
  await assertGstOpen(tx, date, 'purchases', 'no debit note can be dated in it');
  const imported = isImport(supplier, bill.currency);
  const rejectedId = await locationByType(tx, 'rejected');
  const itemRows = await lockItems(tx, want.map((w) => w.line.itemId));
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, grn!.purchaseOrderId));

  const { number: returnNo } = await nextNumber(tx, 'purchase_return', date);
  const [ret] = await tx
    .insert(purchaseReturns)
    .values({ returnNo, grnId, supplierId: supplier.id, notes: input.notes ?? null, createdBy: ctx.user?.id ?? null })
    .returning();

  const computed: LineTax[] = [];
  const dnLines: (typeof purchaseBillLines.$inferInsert)[] = [];
  let stockValue = D(0);
  for (const [idx, w] of want.entries()) {
    const item = itemById.get(w.line.itemId)!;
    const gstRate = imported ? '0' : (poLines.find((p) => p.id === w.line.poLineId)?.gstRate ?? item.gstRate);
    // Out at the same PO rate it came in at, so the stock value and the debit note agree exactly.
    const out = await stockOut(ctx, {
      itemId: item.id, locationId: rejectedId, qty: w.qty, unitCostOverride: w.line.rate, movementType: 'purchase_return_out',
      refType: 'purchase_return', refId: ret!.id, itemName: item.name, reason: w.line.rejectReason,
    });
    stockValue = stockValue.plus(out.value);
    const tax = computeLine({ qty: w.qty, rate: w.line.rate, gstRate }, inter, false);
    computed.push(tax);
    dnLines.push({
      billId: '', poLineId: w.line.poLineId, itemId: item.id, description: `${item.name} (rejected: ${w.line.rejectReason ?? 'QC'})`,
      hsnSac: item.hsnSac, qty: fmtQty(w.qty), rate: w.line.rate, taxableValue: money(tax.taxableValue), gstRate,
      cgst: money(tax.cgst), sgst: money(tax.sgst), igst: money(tax.igst), lineTotal: money(tax.lineTotal), sort: idx,
    });
    await tx.insert(purchaseReturnLines).values({ returnId: ret!.id, grnLineId: w.line.id, itemId: item.id, qty: fmtQty(w.qty), rate: w.line.rate });
    await tx.update(goodsReceiptLines).set({ returnedQty: fmtQty(D(w.line.returnedQty).plus(w.qty)) }).where(eq(goodsReceiptLines.id, w.line.id));
  }

  const totals = computeTotals(computed, false);
  const { number: dnNo, fy } = await nextNumber(tx, 'debit_note', date);
  const [debitNote] = await tx
    .insert(purchaseBills)
    .values({
      docType: 'debit_note', billNo: dnNo, fy, supplierInvoiceNo: bill.supplierInvoiceNo, billDate: date, supplierId: supplier.id,
      purchaseOrderId: grn!.purchaseOrderId, againstBillId: bill.id, placeOfSupply: company.state_code,
      taxableTotal: money(totals.taxableTotal), cgstTotal: money(totals.cgstTotal), sgstTotal: money(totals.sgstTotal),
      igstTotal: money(totals.igstTotal), roundOff: '0', grandTotal: money(totals.grandTotal),
      notes: `Return ${returnNo} of goods rejected on ${grn!.grnNo}`, createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await tx.insert(purchaseBillLines).values(dnLines.map((l) => ({ ...l, billId: debitNote!.id })));
  await tx.update(purchaseReturns).set({ debitNoteId: debitNote!.id }).where(eq(purchaseReturns.id, ret!.id));

  const jl: JLine[] = [
    { account: 'creditors', partyId: supplier.id, debit: totals.grandTotal },
    { account: 'stock', credit: stockValue },
    { account: 'input_cgst', credit: totals.cgstTotal },
    { account: 'input_sgst', credit: totals.sgstTotal },
    { account: 'input_igst', credit: totals.igstTotal },
  ];
  await postJournal(ctx, {
    date, refType: 'purchase_return', refId: ret!.id,
    narration: `Debit note ${dnNo} - rejected goods returned to ${supplier.name} (${returnNo})`, lines: jl,
  });
  await audit(ctx, 'purchase_return', ret!.id, 'create', null, { ...ret, debitNoteId: debitNote!.id, lines: want.map((w) => ({ grnLineId: w.line.id, qty: fmtQty(w.qty) })) });
  return { return: { ...ret!, debitNoteId: debitNote!.id }, debit_note: debitNote! };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export function purchasingRouter(db: DB) {
  const r = Router();
  const zPoLine = z.object({ item_id: zId, qty: zQty, rate: emptyToNull(zMoney).optional() });
  const toPoLine = (l: z.infer<typeof zPoLine>): PoLineInput => ({ itemId: l.item_id, qty: l.qty, rate: l.rate ?? null });

  // ---- purchase orders ----
  r.get('/orders', requirePerm('purchasing:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(PO_STATUSES).optional(), supplier_id: zId.optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select po.*, s.name as supplier_name,
             (select coalesce(sum(l.qty * l.rate), 0)::numeric(14,2) from purchase_order_lines l where l.purchase_order_id = po.id) as amount,
             (select coalesce(sum(l.qty), 0) from purchase_order_lines l where l.purchase_order_id = po.id) as ordered_qty,
             (select coalesce(sum(l.received_qty), 0) from purchase_order_lines l where l.purchase_order_id = po.id) as received_qty
        from purchase_orders po join parties s on s.id = po.supplier_id
       where (${q.status ?? null}::text is null or po.status::text = ${q.status ?? null})
         and (${q.supplier_id ?? null}::uuid is null or po.supplier_id = ${q.supplier_id ?? null}::uuid)
         and (${like}::text is null or po.po_no ilike ${like} or s.name ilike ${like})
       order by po.order_date desc, po.created_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'purchase-orders', { limit: q.limit });
  });

  /** How many purchase orders are at each status: the counters above the list. */
  r.get('/orders/summary', requirePerm('purchasing:read'), async (_req, res) => {
    const counts = await rows<{ status: string; n: number }>(db, sql`select status::text as status, count(*)::int as n from purchase_orders group by status`);
    res.json({ data: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
  });

  r.get('/orders/:id', requirePerm('purchasing:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [po] = await rows(db, sql`
      select po.*, s.name as supplier_name, s.gstin as supplier_gstin, s.phone as supplier_phone, s.billing_address as supplier_address,
             s.state_code as supplier_state_code
        from purchase_orders po join parties s on s.id = po.supplier_id where po.id = ${id}`);
    must(po, 'Purchase order');
    const lines = await rows(db, sql`
      select l.*, i.sku, i.name as item_name, i.unit, i.hsn_sac, (l.qty * l.rate)::numeric(14,2) as amount,
             (select coalesce(sum(bl.qty), 0) from purchase_bill_lines bl join purchase_bills b on b.id = bl.bill_id
               where bl.po_line_id = l.id and b.doc_type = 'bill' and b.status = 'posted') as billed_qty
        from purchase_order_lines l join items i on i.id = l.item_id where l.purchase_order_id = ${id} order by l.sort`);
    res.json({
      data: {
        ...po, lines,
        receipts: await rows(db, sql`select id, grn_no, received_at, status from goods_receipts where purchase_order_id = ${id} order by received_at`),
        shipment: (await rows(db, sql`
          select s.id, s.shipment_no, s.stage from import_shipment_orders o join import_shipments s on s.id = o.shipment_id where o.purchase_order_id = ${id}`))[0] ?? null,
        bills: await rows(db, sql`
          select id, doc_type, bill_no, supplier_invoice_no, bill_date, grand_total, status, mismatches
            from purchase_bills where purchase_order_id = ${id} order by created_at`),
        company: await getCompany(db),
      },
    });
  });

  r.post('/orders', requirePerm('po:write'), async (req, res) => {
    const b = z.object({
      supplier_id: zId, order_date: zDate.prefault(() => istDate()), expected_date: emptyToNull(zDate).optional(),
      notes: emptyToNull(z.string().trim().max(2000)).optional(), lines: z.array(zPoLine).min(1).max(200),
      currency: zCurrency, fx_rate: emptyToNull(zFxRate).optional(),
    }).parse(req.body);
    const po = await inTx(db, req, (ctx) =>
      createPurchaseOrder(ctx, {
        supplierId: b.supplier_id, orderDate: b.order_date, expectedDate: b.expected_date, notes: b.notes, lines: b.lines.map(toPoLine),
        currency: b.currency, fxRate: b.fx_rate,
      }));
    res.status(201).json({ data: po });
  });

  r.put('/orders/:id/lines', requirePerm('po:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ lines: z.array(zPoLine).min(1).max(200) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const [po] = await ctx.tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
      must(po, 'Purchase order');
      if (po!.status !== 'draft') throw conflict('Only a draft PO can be edited');
      const supplier = await loadSupplier(ctx.tx, po!.supplierId);
      const lines = await buildPoLines(ctx.tx, b.lines.map(toPoLine), po!.orderDate, po!.fxRate, isImport(supplier, po!.currency));
      await ctx.tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
      await ctx.tx.insert(purchaseOrderLines).values(lines.map((l) => ({ ...l, purchaseOrderId: id })));
      await audit(ctx, 'purchase_order', id, 'update_lines', null, lines);
    });
    res.json({ ok: true });
  });

  /** Approve a PO waiting above its sender's limit: it is sent. Or send it back to draft, with the reason. */
  r.post('/orders/:id/approve', requirePerm('po:approve'), async (req, res) => {
    const id = zId.parse(req.params.id);
    res.json({ data: await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
      must(row, 'Purchase order');
      if (row!.status !== 'pending_approval') throw conflict(`PO ${row!.poNo} is not waiting for approval`);
      return setPoStatus(ctx, row!, 'sent', { approved: true });
    }) });
  });
  r.post('/orders/:id/reject', requirePerm('po:approve'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    res.json({ data: await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
      must(row, 'Purchase order');
      if (row!.status !== 'pending_approval') throw conflict(`PO ${row!.poNo} is not waiting for approval`);
      return setPoStatus(ctx, row!, 'draft', { rejected: b.reason });
    }) });
  });

  /** The amount each role may send a PO for (with GST); above it the PO waits for approval. */
  r.get('/approval-limits', requirePerm('purchasing:read'), async (_req, res) => {
    res.json({ data: await db.select().from(poApprovalLimits).orderBy(asc(poApprovalLimits.role)) });
  });
  r.put('/approval-limits', requirePerm('settings:manage'), async (req, res) => {
    const b = z.object({ limits: z.array(z.object({ role: z.enum(ROLES), max_amount: emptyToNull(zMoney) })).max(ROLES.length) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await ctx.tx.select().from(poApprovalLimits);
      for (const l of b.limits) {
        if (l.max_amount == null) await ctx.tx.delete(poApprovalLimits).where(eq(poApprovalLimits.role, l.role));
        else {
          await ctx.tx.insert(poApprovalLimits).values({ role: l.role, maxAmount: money(l.max_amount), createdBy: ctx.user!.id })
            .onConflictDoUpdate({ target: poApprovalLimits.role, set: { maxAmount: money(l.max_amount), updatedAt: new Date() } });
        }
      }
      await audit(ctx, 'settings', 'po_approval_limits', 'update', before, b.limits);
    });
    res.json({ data: await db.select().from(poApprovalLimits).orderBy(asc(poApprovalLimits.role)) });
  });

  /** draft -> sent (placed with the supplier) | sent -> closed (short-close) | cancel before any receipt. */
  r.post('/orders/:id/:action', requirePerm('po:write'), async (req, res, next) => {
    const action = req.params.action;
    if (!['send', 'close', 'cancel'].includes(String(action))) return next();
    const id = zId.parse(req.params.id);
    const po = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
      must(row, 'Purchase order');
      if (action === 'send') {
        if (row!.status !== 'draft') throw conflict(`PO is already ${row!.status.replace('_', ' ')}`);
        // Over the sender's limit (with GST), it waits for someone who may approve it; they send it straight away.
        const total = await poTotal(ctx.tx, row!.id);
        const [limit] = await ctx.tx.select().from(poApprovalLimits).where(eq(poApprovalLimits.role, ctx.user!.role));
        if (limit && total.gt(limit.maxAmount) && !can(ctx.user!.role, 'po:approve')) {
          return setPoStatus(ctx, row!, 'pending_approval', { total: money(total), limit: limit.maxAmount });
        }
        return setPoStatus(ctx, row!, 'sent');
      }
      if (action === 'close') {
        if (!['sent', 'partly_received', 'received'].includes(row!.status)) throw conflict(`A ${row!.status} PO cannot be closed`);
        return setPoStatus(ctx, row!, 'closed');
      }
      if (!['draft', 'sent', 'pending_approval'].includes(row!.status)) throw conflict('Goods have been received against this PO, so it cannot be cancelled. Close it instead.');
      const [grn] = await rows(ctx.tx, sql`select 1 as x from goods_receipts where purchase_order_id = ${id} and status <> 'cancelled' limit 1`);
      if (grn) throw conflict('There is a goods receipt against this PO');
      return setPoStatus(ctx, row!, 'cancelled');
    });
    res.json({ data: po });
  });

  // ---- goods receipts (inward + QC) ----
  r.get('/receipts', requirePerm('purchasing:read'), async (req, res) => {
    const q = zListQuery.extend({ status: z.enum(['received', 'inwarded', 'cancelled']).optional(), pending_return: z.enum(['true']).optional() }).parse(req.query);
    const data = await rows(db, sql`
      select g.*, s.name as supplier_name, po.po_no,
             (select coalesce(sum(l.received_qty), 0) from goods_receipt_lines l where l.grn_id = g.id) as received_qty,
             (select coalesce(sum(l.accepted_qty), 0) from goods_receipt_lines l where l.grn_id = g.id) as accepted_qty,
             (select coalesce(sum(l.rejected_qty), 0) from goods_receipt_lines l where l.grn_id = g.id) as rejected_qty,
             (select coalesce(sum(coalesce(l.rejected_qty, 0) - l.returned_qty), 0) from goods_receipt_lines l where l.grn_id = g.id) as pending_return_qty
        from goods_receipts g join parties s on s.id = g.supplier_id join purchase_orders po on po.id = g.purchase_order_id
       where (${q.status ?? null}::text is null or g.status::text = ${q.status ?? null})
         and (${q.pending_return ?? null}::text is null or exists (
               select 1 from goods_receipt_lines l where l.grn_id = g.id and coalesce(l.rejected_qty, 0) > l.returned_qty))
       order by g.received_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'goods-receipts', { limit: q.limit });
  });

  r.get('/receipts/:id', requirePerm('purchasing:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [grn] = await rows(db, sql`
      select g.*, s.name as supplier_name, po.po_no from goods_receipts g
        join parties s on s.id = g.supplier_id join purchase_orders po on po.id = g.purchase_order_id where g.id = ${id}`);
    must(grn, 'Goods receipt');
    const lines = await rows(db, sql`
      select l.*, i.sku, i.name as item_name, i.unit, i.is_serialised, u.name as qc_by_name,
             (select b.batch_no from batches b where b.id = l.batch_id) as batch_no,
             -- the serials this line brought in (named at QC)
             (select json_agg(u2.serial_no order by u2.serial_no) from unit_events e join units u2 on u2.id = e.unit_id
               where e.ref_type = 'goods_receipt' and e.ref_id = l.grn_id and e.event = 'received' and u2.item_id = l.item_id) as serials
        from goods_receipt_lines l join items i on i.id = l.item_id left join users u on u.id = l.qc_by
       where l.grn_id = ${id} order by i.name`);
    const returns = await rows(db, sql`
      select r.id, r.return_no, r.returned_at, b.bill_no as debit_note_no, b.grand_total as debit_note_total
        from purchase_returns r left join purchase_bills b on b.id = r.debit_note_id where r.grn_id = ${id} order by r.returned_at`);
    res.json({ data: { ...grn, lines, returns } });
  });

  r.post('/receipts', requirePerm('grn:write'), async (req, res) => {
    const b = z.object({
      purchase_order_id: zId, notes: emptyToNull(z.string().trim().max(1000)).optional(),
      lines: z.array(z.object({ po_line_id: zId, received_qty: zQty })).min(1),
    }).parse(req.body);
    const grn = await inTx(db, req, (ctx) =>
      createGoodsReceipt(ctx, { purchaseOrderId: b.purchase_order_id, notes: b.notes, lines: b.lines.map((l) => ({ poLineId: l.po_line_id, receivedQty: l.received_qty })) }));
    res.status(201).json({ data: grn });
  });

  r.post('/receipts/:id/qc', requirePerm('grn:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      lines: z.array(z.object({
        grn_line_id: zId, accepted_qty: zQtyNonNeg, rejected_qty: zQtyNonNeg.prefault('0'),
        reject_reason: emptyToNull(z.string().trim().max(500)).optional(),
        serials: zSerials.optional(),
        batch_no: emptyToNull(z.string().trim().max(60)).optional(),
        mfg_date: emptyToNull(zDate).optional(),
        chemistry: emptyToNull(z.string().trim().max(60)).optional(),
        weight_kg: emptyToNull(zQtyNonNeg).optional(),
      })).min(1),
    }).parse(req.body);
    const grn = await inTx(db, req, (ctx) =>
      qcGoodsReceipt(ctx, id, {
        lines: b.lines.map((l) => ({
          grnLineId: l.grn_line_id, acceptedQty: l.accepted_qty, rejectedQty: l.rejected_qty, rejectReason: l.reject_reason, serials: l.serials,
          batch: l.batch_no ? { batchNo: l.batch_no, mfgDate: l.mfg_date, chemistry: l.chemistry, weightKg: l.weight_kg } : null,
        })),
      }));
    res.json({ data: grn });
  });

  /** A receipt entered by mistake can be cancelled only before QC (after that, stock has moved). */
  r.post('/receipts/:id/cancel', requirePerm('grn:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const grn = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, id)).for('update');
      must(row, 'Goods receipt');
      if (row!.status !== 'received') throw conflict('Only a receipt still waiting for QC can be cancelled');
      const lines = await ctx.tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.grnId, id));
      for (const l of lines) {
        await ctx.tx.execute(sql`update purchase_order_lines set received_qty = received_qty - ${l.receivedQty}::numeric where id = ${l.poLineId}`);
      }
      const [updated] = await ctx.tx.update(goodsReceipts).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(goodsReceipts.id, id)).returning();
      await refreshPoStatus(ctx, row!.purchaseOrderId);
      await audit(ctx, 'goods_receipt', id, 'cancel', { status: 'received' }, { status: 'cancelled' });
      return updated;
    });
    res.json({ data: grn });
  });

  r.post('/receipts/:id/return', requirePerm('grn:write', 'bills:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      lines: z.array(z.object({ grn_line_id: zId, qty: zQty })).min(1).optional(),
      notes: emptyToNull(z.string().trim().max(1000)).optional(),
      date: zDate.optional(),
    }).parse(req.body ?? {});
    const result = await inTx(db, req, (ctx) =>
      createSupplierReturn(ctx, id, { lines: b.lines?.map((l) => ({ grnLineId: l.grn_line_id, qty: l.qty })), notes: b.notes, date: b.date }));
    res.status(201).json({ data: result });
  });

  // ---- purchase bills & debit notes ----
  r.get('/bills', requirePerm('purchasing:read'), async (req, res) => {
    const q = zListQuery.extend({
      doc_type: z.enum(['bill', 'debit_note']).optional(), supplier_id: zId.optional(),
      payment_status: z.enum(['unpaid', 'partly_paid', 'paid']).optional(), from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select b.id, b.doc_type, b.bill_no, b.supplier_invoice_no, b.bill_date, b.due_date, b.supplier_id, s.name as supplier_name,
             b.taxable_total, b.cgst_total, b.sgst_total, b.igst_total, b.grand_total, b.status, b.mismatches, po.po_no,
             o.outstanding, o.payment_status,
             case when o.outstanding > 0 and b.due_date < (now() at time zone 'Asia/Kolkata')::date then (now() at time zone 'Asia/Kolkata')::date - b.due_date else 0 end as days_overdue
        from purchase_bills b join parties s on s.id = b.supplier_id
        left join purchase_orders po on po.id = b.purchase_order_id
        left join v_bill_outstanding o on o.bill_id = b.id
       where (${q.doc_type ?? null}::text is null or b.doc_type::text = ${q.doc_type ?? null})
         and (${q.supplier_id ?? null}::uuid is null or b.supplier_id = ${q.supplier_id ?? null}::uuid)
         and (${q.payment_status ?? null}::text is null or o.payment_status = ${q.payment_status ?? null})
         and (${q.from ?? null}::date is null or b.bill_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or b.bill_date <= ${q.to ?? null}::date)
         and (${like}::text is null or b.bill_no ilike ${like} or b.supplier_invoice_no ilike ${like} or s.name ilike ${like})
       order by b.bill_date desc, b.created_at desc
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'purchase-bills', { limit: q.limit });
  });

  r.get('/bills/:id', requirePerm('purchasing:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [bill] = await rows(db, sql`
      select b.*, s.name as supplier_name, s.gstin as supplier_gstin, s.billing_address as supplier_address, po.po_no, jw.challan_no as job_work_challan_no,
             sh.shipment_no as import_shipment_no, o.allocated, o.debited, o.outstanding, o.payment_status
        from purchase_bills b join parties s on s.id = b.supplier_id
        left join purchase_orders po on po.id = b.purchase_order_id
        left join job_works jw on jw.id = b.job_work_id
        left join import_shipments sh on sh.id = b.import_shipment_id
        left join v_bill_outstanding o on o.bill_id = b.id where b.id = ${id}`);
    must(bill, 'Purchase bill');
    const lines = await rows(db, sql`
      select l.*, i.sku, i.name as item_name, i.unit from purchase_bill_lines l join items i on i.id = l.item_id
       where l.bill_id = ${id} order by l.sort`);
    const paymentsMade = await rows(db, sql`
      select p.id, p.payment_no, p.paid_on, p.mode, p.reference, pa.amount
        from payment_allocations pa join payments p on p.id = pa.payment_id
       where pa.purchase_bill_id = ${id} and p.status = 'posted' order by p.paid_on`);
    const debitNotes = await rows(db, sql`
      select id, bill_no, bill_date, grand_total from purchase_bills where against_bill_id = ${id} and status = 'posted' order by bill_date`);
    res.json({ data: { ...bill, lines, payments: paymentsMade, debit_notes: debitNotes, company: await getCompany(db) } });
  });

  r.post('/bills', requirePerm('bills:write'), async (req, res) => {
    const b = z.object({
      supplier_id: zId,
      purchase_order_id: emptyToNull(zId).optional(),
      supplier_invoice_no: zText(60),
      bill_date: zDate,
      due_date: emptyToNull(zDate).optional(),
      round_off: emptyToNull(zSignedMoney).optional(),
      notes: emptyToNull(z.string().trim().max(2000)).optional(),
      job_work_id: emptyToNull(zId).optional(),
      import_shipment_id: emptyToNull(zId).optional(),
      currency: zCurrency, fx_rate: emptyToNull(zFxRate).optional(),
      lines: z.array(z.object({
        po_line_id: emptyToNull(zId).optional(), item_id: emptyToNull(zId).optional(), qty: zQty, rate: zMoney,
        description: emptyToNull(z.string().trim().max(300)).optional(), landed_kind: z.enum(LANDED_COST_KINDS).nullish(),
      })).min(1).max(200),
    }).parse(req.body);
    const bill = await inTx(db, req, (ctx) =>
      createPurchaseBill(ctx, {
        supplierId: b.supplier_id, purchaseOrderId: b.purchase_order_id, supplierInvoiceNo: b.supplier_invoice_no, billDate: b.bill_date,
        dueDate: b.due_date, roundOff: b.round_off, notes: b.notes, jobWorkId: b.job_work_id, currency: b.currency, fxRate: b.fx_rate,
        importShipmentId: b.import_shipment_id,
        lines: b.lines.map((l) => ({ poLineId: l.po_line_id, itemId: l.item_id, qty: l.qty, rate: l.rate, description: l.description, landedKind: l.landed_kind })),
      }));
    res.status(201).json({ data: bill });
  });

  r.post('/bills/:id/cancel', requirePerm('bills:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ reason: zText(500) }).parse(req.body);
    res.json({ data: await inTx(db, req, (ctx) => cancelPurchaseBill(ctx, id, b.reason)) });
  });

  /** Payables per supplier (PRD 7.7). */
  r.get('/payables', requirePerm('purchasing:read'), async (req, res) => {
    const data = await rows(db, sql`
      select s.id as supplier_id, s.name as supplier_name, count(*)::int as open_bills, sum(o.outstanding) as outstanding,
             sum(o.outstanding) filter (where o.due_date < (now() at time zone 'Asia/Kolkata')::date) as overdue, min(o.due_date) as oldest_due
        from v_bill_outstanding o join parties s on s.id = o.supplier_id
       where o.outstanding > 0 group by s.id, s.name order by sum(o.outstanding) desc`);
    sendList(req, res, data, 'payables');
  });
  return r;
}

