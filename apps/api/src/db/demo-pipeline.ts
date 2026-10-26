import { eq } from 'drizzle-orm';
import { addDays, istDate } from '@radcore/shared';
import type { Ctx } from '../lib/http';
import { createAdjustment, decideAdjustment } from '../modules/inventory';
import { bookTestRide, bookVehicle } from '../modules/pipeline';
import type { DB } from './client';
import { items, leads, locations, units } from './schema';

/**
 * Sample vehicle pipeline (part of `npm run demo`, see demo.ts): a demo scooter for test rides, Asha's test
 * ride tomorrow morning, and Vikram's booking of a showroom scooter with a ₹10,000 advance.
 */
export async function seedPipeline(ctx: Ctx) {
  const tx = ctx.tx as DB;
  const [scooter] = await tx.select({ id: items.id }).from(items).where(eq(items.sku, 'EV-S1'));
  const [place] = await tx.insert(locations).values({ name: 'Demo fleet', type: 'demo', createdBy: ctx.user?.id ?? null }).returning();
  const adj = await createAdjustment(ctx, {
    kind: 'opening', locationId: place!.id, reason: 'Test ride scooter (demo)', lines: [{ itemId: scooter!.id, qtyChange: '1', unitCost: '62000', serials: ['S1-DEMO-01'] }],
  });
  await decideAdjustment(ctx, adj.id, true);
  const lead = async (phone: string) => (await tx.select().from(leads).where(eq(leads.phone, phone)))[0]!;
  const [demoUnit] = await tx.select({ id: units.id }).from(units).where(eq(units.serialNo, 'S1-DEMO-01'));
  await bookTestRide(ctx, (await lead('+919820011111')).id, { unitId: demoUnit!.id, slotAt: `${addDays(istDate(), 1)}T11:00:00+05:30`, minutes: 30 });
  const [showroom] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.type, 'showroom'));
  await bookVehicle(ctx, (await lead('+919820022222')).id, {
    itemId: scooter!.id, serial: 'S1-24A0101', locationId: showroom!.id, advance: { mode: 'upi', amount: '10000', reference: 'UPI 4401' },
  });
}
