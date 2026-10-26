import { eq } from 'drizzle-orm';
import { addDays, istDate } from '@radcore/shared';
import type { Ctx } from '../lib/http';
import { addPaidCost, applyCosts, createShipment, setStage } from '../modules/imports';
import { createParty } from '../modules/parties';
import { createGoodsReceipt, createPurchaseBill, createPurchaseOrder, qcGoodsReceipt } from '../modules/purchasing';
import type { DB } from './client';
import { accounts, goodsReceiptLines, items, purchaseOrderLines, purchaseOrders } from './schema';

/**
 * Sample imports (part of `npm run demo`, see demo.ts): two shipments of cells from China. One is received,
 * its freight, duty and truck costed and put on the goods (₹84 cells land at ₹98.92); the other is at the
 * port with only the forwarder's bill so far.
 */
export async function seedImports(ctx: Ctx) {
  const tx = ctx.tx as DB;
  const [cells, freight] = await tx.insert(items).values([
    { sku: 'CELL-21700', name: 'Cell 21700', itemType: 'spare_part', hsnSac: '850760', gstRate: '18', purchaseCost: '84', retailPrice: '236', weightKg: '0.070' },
    { sku: 'SVC-FRT', name: 'Freight & clearing', itemType: 'service', hsnSac: '996531', gstRate: '18', isStockItem: false },
  ]).returning();
  const shenzhen = await createParty(ctx, { party_type: 'supplier', name: 'Shenzhen Cells Co', phone: '+8675512345678' });
  const forwarder = await createParty(ctx, { party_type: 'supplier', name: 'Pune Freight Movers', phone: '+919700000062', payment_terms_days: 15 });
  const bank = (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, 'bank')))[0]!.id;
  const cash = (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, 'cash')))[0]!.id;

  const order = async (qty: string) => {
    const po = await createPurchaseOrder(ctx, { supplierId: shenzhen.id, orderDate: addDays(istDate(), -45), currency: 'USD', fxRate: '84', lines: [{ itemId: cells!.id, qty, rate: '1' }] });
    await tx.update(purchaseOrders).set({ status: 'sent' }).where(eq(purchaseOrders.id, po.id));
    return po;
  };

  // Landed: 2,000 cells at $1 and ₹84 to the dollar, 1,980 passed QC, then freight, duty and the truck.
  const po1 = await order('2000');
  const s1 = await createShipment(ctx, { supplierId: shenzhen.id, purchaseOrderIds: [po1.id], currency: 'USD', fxRate: '84', blAwbNo: 'MSKU7781234' });
  for (const [stage, ago] of [['advance_paid', 40], ['production', 35], ['shipped', 25], ['at_port', 8], ['boe_filed', 6], ['cleared', 4], ['received', 3]] as const) {
    await setStage(ctx, s1.id, stage, addDays(istDate(), -ago));
  }
  const [pol1] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po1.id));
  const grn = await createGoodsReceipt(ctx, { purchaseOrderId: po1.id, lines: [{ poLineId: pol1!.id, receivedQty: '2000' }] });
  const [gl] = await tx.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.grnId, grn.id));
  await qcGoodsReceipt(ctx, grn.id, { lines: [{ grnLineId: gl!.id, acceptedQty: '1980', rejectedQty: '20', rejectReason: 'Dented casing', batch: { batchNo: 'SZ-2611' } }] });
  await createPurchaseBill(ctx, {
    supplierId: forwarder.id, supplierInvoiceNo: 'PFM/889', billDate: addDays(istDate(), -3), importShipmentId: s1.id,
    lines: [{ itemId: freight!.id, qty: '1', rate: '16800', landedKind: 'freight', description: 'Sea freight and clearing, MSKU7781234' }],
  });
  for (const [kind, amount] of [['bcd', '8400'], ['sws', '840'], ['igst', '32000']] as const) {
    await addPaidCost(ctx, s1.id, { kind, amount, paidFromAccountId: bank, description: 'Bill of entry 4455667', paidOn: addDays(istDate(), -6) });
  }
  await addPaidCost(ctx, s1.id, { kind: 'inland', amount: '3500', basis: 'qty', paidFromAccountId: cash, description: 'Truck from JNPT to Pune', paidOn: addDays(istDate(), -3) });
  await applyCosts(ctx, s1.id);

  // At the port: 1,000 cells, the forwarder's bill in, the duty not yet paid.
  const po2 = await order('1000');
  const s2 = await createShipment(ctx, { supplierId: shenzhen.id, purchaseOrderIds: [po2.id], currency: 'USD', fxRate: '84', blAwbNo: 'OOLU5550192' });
  for (const [stage, ago] of [['advance_paid', 30], ['production', 20], ['shipped', 12], ['at_port', 1]] as const) {
    await setStage(ctx, s2.id, stage, addDays(istDate(), -ago));
  }
  await createPurchaseBill(ctx, {
    supplierId: forwarder.id, supplierInvoiceNo: 'PFM/912', billDate: istDate(), importShipmentId: s2.id,
    lines: [{ itemId: freight!.id, qty: '1', rate: '8400', landedKind: 'freight', description: 'Sea freight, OOLU5550192' }],
  });
}
