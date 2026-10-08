import { ROLES, gstinCheckChar, istDate } from '@radcore/shared';
import { hashPassword } from '../core/auth';
import { setSetting } from '../core/settings';
import type { Ctx } from '../lib/http';
import { createAdjustment, decideAdjustment } from '../modules/inventory';
import { captureLead, sourceIdByName } from '../modules/leads';
import { createParty } from '../modules/parties';
import { rows, sql, type DB } from './client';
import { items, users } from './schema';

/**
 * Sample data for trying the system out. Used ONLY by `npm run demo`, which runs on a
 * throwaway in-memory database - never against real data.
 *
 * Demo sign-in: phone 9000000000 .. 9000000006 (one per role, in the order of ROLES:
 * owner, marketing, store, sales, stores, accounts, admin), password below.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'radcore-demo';

const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;

export async function seedDemo(db: DB): Promise<void> {
  const hash = await hashPassword(DEMO_PASSWORD);
  await db.insert(users).values(
    ROLES.map((role, i) => ({ name: `Demo ${role[0]!.toUpperCase()}${role.slice(1)}`, phone: `+91900000000${i}`, passwordHash: hash, role })),
  );
  const [admin] = await rows<{ id: string; name: string; phone: string }>(db, sql`select id, name, phone from users where role = 'admin' limit 1`);

  await setSetting(db, 'company', {
    name: 'Radboards Pvt Ltd (DEMO)', gstin: gstin('27', 'AAPFU0939F'), state_code: '27',
    address: { line1: '12 Skate Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    phone: '+91 20 5550 0100', email: 'accounts@example.com',
    bank: { bank_name: 'Demo Bank', account_no: '000111222333', ifsc: 'DEMO0000001', account_name: 'Radboards Pvt Ltd' },
    invoice_terms: 'Goods once sold are covered by the manufacturer warranty only.',
  }, admin!.id);

  await db.transaction(async (tx) => {
    const ctx: Ctx = { tx: tx as unknown as DB, user: { id: admin!.id, name: admin!.name, phone: admin!.phone, role: 'admin' } };
    const created = await ctx.tx
      .insert(items)
      .values([
        { sku: 'BRD-CRUISER', name: 'Cruiser Board 27"', itemType: 'finished_good', hsnSac: '950699', gstRate: '18', purchaseCost: '2500', mrp: '6499', retailPrice: '5900', dealerPrice: '4000', reorderLevel: '5', barcode: '8900000000011' },
        { sku: 'BRD-LONG', name: 'Longboard 42"', itemType: 'finished_good', hsnSac: '950699', gstRate: '18', purchaseCost: '4200', mrp: '10999', retailPrice: '9440', dealerPrice: '6800', reorderLevel: '3', barcode: '8900000000028' },
        { sku: 'WHL-60', name: 'Wheel Set 60mm', itemType: 'spare_part', hsnSac: '950699', gstRate: '12', purchaseCost: '500', mrp: '1299', retailPrice: '1120', dealerPrice: '800', reorderLevel: '10', barcode: '8900000000035' },
        { sku: 'HLM-01', name: 'Helmet', itemType: 'finished_good', hsnSac: '650610', gstRate: '18', purchaseCost: '700', mrp: '1799', retailPrice: '1534', dealerPrice: '1100', reorderLevel: '5', barcode: '8900000000042' },
        { sku: 'RM-MAPLE', name: 'Maple Ply Sheet', itemType: 'raw_material', hsnSac: '441239', gstRate: '18', unit: 'Sheet', purchaseCost: '900', reorderLevel: '20' },
        { sku: 'SVC-SETUP', name: 'Board Setup & Tuning', itemType: 'service', hsnSac: '998729', gstRate: '18', retailPrice: '236', isStockItem: false },
      ])
      .returning({ id: items.id, sku: items.sku, cost: items.purchaseCost });
    const id = (sku: string) => created.find((i) => i.sku === sku)!.id;

    await createParty(ctx, { party_type: 'supplier', name: 'Deck Makers Pvt Ltd', phone: '+919700000001', gstin: gstin('27', 'SUPPL1234A'), payment_terms_days: 30, billing_address: { line1: 'MIDC Bhosari', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411026' } });
    await createParty(ctx, { party_type: 'dealer', name: 'Bangalore Boards', phone: '+919700000002', gstin: gstin('29', 'DEALR1234B'), credit_limit: '100000.00', payment_terms_days: 15, billing_address: { line1: 'Indiranagar', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } });
    await createParty(ctx, { party_type: 'dealer', name: 'Mumbai Skate Co', phone: '+919700000003', gstin: gstin('27', 'DEALR5678C'), credit_limit: '50000.00', payment_terms_days: 7 });

    const loc = await rows<{ id: string; type: string }>(ctx.tx, sql`select id, type from locations`);
    const at = (type: string) => loc.find((l) => l.type === type)!.id;
    const opening = async (locationId: string, lines: [string, number][]) => {
      const adj = await createAdjustment(ctx, {
        kind: 'opening', locationId, reason: 'Opening stock (demo)',
        lines: lines.map(([sku, qty]) => ({ itemId: id(sku), qtyChange: String(qty), unitCost: created.find((i) => i.sku === sku)!.cost })),
      });
      await decideAdjustment(ctx, adj.id, true);
    };
    await opening(at('stores'), [['BRD-CRUISER', 20], ['BRD-LONG', 8], ['WHL-60', 40], ['HLM-01', 15], ['RM-MAPLE', 60]]);
    await opening(at('showroom'), [['BRD-CRUISER', 6], ['BRD-LONG', 2], ['WHL-60', 12], ['HLM-01', 6]]);

    const lead = (name: string, phone: string, source: string, detail: string | null, sku: string) =>
      sourceIdByName(ctx.tx, source).then((sourceId) =>
        captureLead({ tx: ctx.tx, user: null }, { name, phone, sourceId, sourceDetail: detail, interestedItemIds: [id(sku)] }));
    await lead('Asha Rao', '+919820011111', 'Meta Ads', 'Diwali campaign', 'BRD-CRUISER');
    await lead('Vikram Shah', '+919820022222', 'Google Ads', 'Longboard search', 'BRD-LONG');
    await lead('Neha Kulkarni', '+919820033333', 'Instagram Collab', '@skate.pune', 'HLM-01');
    await lead('Imran Khan', '+919820044444', 'Website', null, 'BRD-CRUISER');
  });
  console.log(`Demo data loaded (${istDate()}). Sign in with phone 9000000006 (admin) and the demo password.`);
}
