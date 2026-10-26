import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { addMonths, istDate } from '@radcore/shared';
import type { Ctx } from '../lib/http';
import { createAdjustment, decideAdjustment } from '../modules/inventory';
import { quickBill } from '../modules/sales';
import { addJobLine, createJobCard, moveJob } from '../modules/service';
import type { DB } from './client';
import { faultCodes, fileContents, files, items, locations, users, warrantyRules } from './schema';

/** A tiny picture standing in for a delivery photo or a signed note in the sample data. */
const SAMPLE_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b60000000049454e44ae426082', 'hex');

/** A scooter sold at the counter in the sample data, with its delivery checklist done (brief P2). */
export async function sampleDeliveryChecks(tx: DB, by: string | null) {
  const file = async (name: string) => {
    const [f] = await tx.insert(files).values({
      purpose: 'delivery', originalName: name, mime: 'image/png', size: SAMPLE_PNG.length, sha256: crypto.createHash('sha256').update(SAMPLE_PNG).digest('hex'), createdBy: by,
    }).returning();
    await tx.insert(fileContents).values({ fileId: f!.id, bytes: SAMPLE_PNG });
    return f!.id;
  };
  return { pdiDone: true, riderBriefing: true, warrantyRegistered: true, photoFileId: await file('handover (sample).png'), signedNoteFileId: await file('signed note (sample).png') };
}

/**
 * Sample data for the workshop (part of `npm run demo`, see demo.ts): a workshop place with spare parts,
 * warranty rules and fault codes, and two scooters back in: one still in warranty, one out of it with
 * an estimate waiting for the customer.
 */
export async function seedService(ctx: Ctx) {
  const tx = ctx.tx as DB;
  const id = async (sku: string) => (await tx.select({ id: items.id }).from(items).where(eq(items.sku, sku)))[0]!.id;
  const [bay] = await tx.insert(locations).values({ name: 'Workshop', type: 'service_bay', createdBy: ctx.user?.id ?? null }).returning();
  const [labour, pads] = await tx.insert(items).values([
    { sku: 'LAB-HR', name: 'Workshop labour (hour)', itemType: 'service', hsnSac: '998714', gstRate: '18', retailPrice: '590', isStockItem: false },
    { sku: 'BRK-PAD', name: 'Brake pad set', itemType: 'spare_part', hsnSac: '870830', gstRate: '18', purchaseCost: '200', retailPrice: '590', dealerPrice: '420' },
  ]).returning();
  const scooter = await id('EV-S1');
  const pack = await id('BAT-60V');
  await tx.insert(warrantyRules).values([{ itemId: scooter, months: 24, kmLimit: 20000 }, { itemId: pack, months: 36 }]);
  await tx.insert(faultCodes).values([
    { code: 'BMS-02', component: 'Battery', description: 'Cell imbalance' },
    { code: 'MTR-01', component: 'Motor', description: 'Hall sensor fault' },
    { code: 'CTR-03', component: 'Controller', description: 'Over-current cut-out' },
    { code: 'BRK-01', component: 'Brakes', description: 'Pads worn' },
  ]);
  const shelf = await createAdjustment(ctx, {
    kind: 'opening', locationId: bay!.id, reason: 'Workshop stock (demo)', lines: [
      { itemId: pads!.id, qtyChange: '10', unitCost: '200' }, { itemId: pack, qtyChange: '1', unitCost: '18000', serials: ['BP60-9001'] },
    ],
  });
  await decideAdjustment(ctx, shelf.id, true);

  // Two scooters sold from the showroom: to Rohit eight months ago (in warranty), to Meera thirty months ago (out of it).
  await quickBill(ctx, { customer: { phone: '+919820088888', name: 'Rohit Patil' }, lines: [{ itemId: scooter, qty: '1', serials: ['S1-24A0102'] }], payments: [{ mode: 'upi', amount: '89250' }], deliveryChecks: await sampleDeliveryChecks(tx, ctx.user?.id ?? null) });
  await quickBill(ctx, { customer: { phone: '+919820066666', name: 'Meera Joshi' }, lines: [{ itemId: scooter, qty: '1', serials: ['S1-24A0103'] }], payments: [{ mode: 'upi', amount: '89250' }], deliveryChecks: await sampleDeliveryChecks(tx, ctx.user?.id ?? null) });
  await tx.execute(sql`update units set sold_on = ${addMonths(istDate(), -8)}::date where serial_no = 'S1-24A0102'`);
  await tx.execute(sql`update units set sold_on = ${addMonths(istDate(), -30)}::date where serial_no = 'S1-24A0103'`);
  const [tech] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'technician'));

  const rohit = await createJobCard(ctx, { serial: 'S1-24A0102', complaint: 'Range has dropped to 40 km; battery warning comes on', odometerKm: 6400, technicianId: tech?.id ?? null });
  await moveJob(ctx, rohit.id, 'diagnosed', { diagnosis: 'Pack has a weak cell group' });
  await addJobLine(ctx, rohit.id, { kind: 'part', itemId: pack, qty: '1' });
  await addJobLine(ctx, rohit.id, { kind: 'labour', itemId: labour!.id, qty: '2' });

  const meera = await createJobCard(ctx, { serial: 'S1-24A0103', complaint: 'Brakes squeal; front brake weak', odometerKm: 21400, technicianId: tech?.id ?? null });
  await moveJob(ctx, meera.id, 'diagnosed', { diagnosis: 'Front and rear pads worn out' });
  await addJobLine(ctx, meera.id, { kind: 'part', itemId: pads!.id, qty: '2' });
  await addJobLine(ctx, meera.id, { kind: 'labour', itemId: labour!.id, qty: '1.5' });
  await moveJob(ctx, meera.id, 'estimate_sent');
}
