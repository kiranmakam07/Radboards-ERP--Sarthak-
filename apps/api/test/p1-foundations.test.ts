import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { gstin, openingStock, setup, type World } from './helpers';

/**
 * P1 of the founder's brief (21 Oct 2026): the schema foundations that get expensive once real
 * data is in, one migration each. This file follows them in order.
 */
let w: World;

const id: Record<string, string> = {};

beforeAll(async () => {
  w = await setup();

});
afterAll(() => w.close());

describe('0026 EV kinds of item, place and party', () => {
  it('takes vehicles, sub-assemblies, accessories and consumables', async () => {
    const admin = await w.as('admin');
    for (const [sku, type] of [['EV-S1', 'vehicle'], ['BAT-48', 'sub_assembly'], ['HLM-EV', 'accessory'], ['GRS-1', 'consumable']] as const) {
      const res = await admin.post('/api/items').send({ sku, name: sku, item_type: type, hsn_sac: '871160', gst_rate: 5, retail_price: 1050, dealer_price: 900, purchase_cost: 700 }).expect(201);
      id[sku] = res.body.data.id;
    }
    const kinds = await rows<{ item_type: string }>(w.db, sql`select item_type::text from items order by sku`);
    expect(kinds.map((k) => k.item_type).sort()).toEqual(['accessory', 'consumable', 'sub_assembly', 'vehicle']);
  });

  it('takes service bay, demo, franchise and in-transit places; goods in transit or in the workshop cannot be delivered', async () => {
    const admin = await w.as('admin');
    for (const [name, type] of [['Workshop', 'service_bay'], ['Demo fleet', 'demo'], ['Nashik franchise', 'franchise'], ['On the road', 'in_transit']] as const) {
      id[type] = (await admin.post('/api/masters/locations').send({ name, type }).expect(201)).body.data.id;
    }
    await openingStock(w, id.in_transit!, [{ item_id: id['EV-S1']!, qty_change: '2', unit_cost: '700' }]);
    await openingStock(w, id.demo!, [{ item_id: id['EV-S1']!, qty_change: '1', unit_cost: '700' }]);
    const onHand = (await admin.get('/api/stock/on-hand').expect(200)).body.data.find((r: any) => r.sku === 'EV-S1');
    // Ours, but not on the shelf: not "available".
    expect([Number(onHand.available_qty), Number(onHand.elsewhere_qty)]).toEqual([0, 3]);

    const sales = await w.as('sales');
    const cust = await admin.post('/api/parties').send({ party_type: 'customer', name: 'Ria', phone: '9811000001' }).expect(201);
    const order = (await sales.post('/api/sales/orders').send({ channel: 'store', party_id: cust.body.data.id, lines: [{ item_id: id['EV-S1'], qty: 1 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
    const refused = await sales.post(`/api/sales/orders/${order.id}/deliver`).send({ location_id: id.in_transit }).expect(400);
    expect(refused.body.error.message).toMatch(/On the road cannot be delivered from/);
    // A demo unit can be sold as such.
    await sales.post(`/api/sales/orders/${order.id}/deliver`).send({ location_id: id.demo }).expect(201);
  });

  it('sells to a franchisee at the dealer price, like a dealer', async () => {
    const admin = await w.as('admin');
    const fr = await admin.post('/api/parties').send({ party_type: 'franchisee', name: 'Nashik EV Point', phone: '9700000021', gstin: gstin('27', 'FRANC1234F') }).expect(201);
    id.franchisee = fr.body.data.id;
    const preview = await (await w.as('sales')).post('/api/sales/price-preview').send({ party_id: id.franchisee, lines: [{ item_id: id['HLM-EV'], qty: 1 }] }).expect(200);
    expect(preview.body.data.lines[0].rate).toBe('900.00');
    const list = await admin.get('/api/parties?side=customers').expect(200);
    expect(list.body.data.map((p: any) => p.name)).toContain('Nashik EV Point');
  });
});
