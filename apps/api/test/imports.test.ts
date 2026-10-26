import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, setup, type World } from './helpers';

/**
 * Imports and landed cost (P2 of the brief), with figures worked out by hand.
 *
 *   2,000 cells ordered from Shenzhen at $1 each, ₹84 to the dollar: ₹84 a cell. 1,980 pass QC.
 *   Costs: the forwarder's freight ₹16,800 (+ 18% GST, which is input credit); on the bill of entry BCD ₹8,400,
 *   SWS ₹840 and IGST ₹32,000 (input credit, never cost); the truck to Pune ₹3,500, by quantity.
 *   Spread: ₹29,540 over 1,980 cells = ₹14.92 a cell, so a cell lands at ₹98.92.
 *   198 cells (a tenth) were sold before the costs came in: a tenth of the ₹29,540 goes to cost of goods sold.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

const balance = async (key: string, partyId?: string) => Number((await rows<{ b: string }>(w.db, sql`
  select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
   where a.system_key = ${key} and (${partyId ?? null}::uuid is null or l.party_id = ${partyId ?? null}::uuid)`))[0]!.b);
const cellValue = async () => (await rows<{ q: string; v: string }>(w.db, sql`
  select coalesce(sum(m.qty), 0)::text as q, coalesce(sum(m.value), 0)::text as v from stock_movements m join locations l on l.id = m.location_id
   where m.item_id = ${id.cell} and l.type <> 'rejected'`))[0]!;

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const stores = await w.as('stores');
  id.cell = (await admin.post('/api/items').send({ sku: 'CELL-21700', name: 'Cell 21700', item_type: 'spare_part', hsn_sac: '850760', gst_rate: 18, retail_price: 236 }).expect(201)).body.data.id;
  id.freight = (await admin.post('/api/items').send({ sku: 'SVC-FRT', name: 'Freight & clearing', item_type: 'service', hsn_sac: '996531', gst_rate: 18 }).expect(201)).body.data.id;
  id.foreign = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Shenzhen Cells Co', phone: '9700000061' }).expect(201)).body.data.id;
  id.forwarder = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Pune Freight Movers', phone: '9700000062', gstin: gstin('27', 'FRTMV1234F') }).expect(201)).body.data.id;
  const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.foreign, currency: 'USD', fx_rate: '84', lines: [{ item_id: id.cell, qty: 2000, rate: 1 }] }).expect(201)).body.data;
  await stores.post(`/api/purchasing/orders/${po.id}/send`).send({}).expect(200);
  id.po = po.id;
  id.poLine = (await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines[0].id;
});
afterAll(() => w.close());

describe('a shipment, stage by stage', () => {
  it('carries the supplier\'s orders, and not another supplier\'s or one already shipped', async () => {
    const stores = await w.as('stores');
    await stores.post('/api/imports').send({ supplier_id: id.forwarder, purchase_order_ids: [id.po] }).expect(400);
    const res = await stores.post('/api/imports').send({ supplier_id: id.foreign, purchase_order_ids: [id.po], currency: 'USD', fx_rate: '84', bl_awb_no: 'MSKU7781234' }).expect(201);
    id.ship = res.body.data.id;
    expect(res.body.data.shipment_no).toMatch(/^IMP\/\d\d-\d\d\/00001$/);
    const again = await stores.post('/api/imports').send({ supplier_id: id.foreign, purchase_order_ids: [id.po] }).expect(409);
    expect(again.body.error.message).toMatch(/already on shipment IMP/);
    await stores.post(`/api/imports/${id.ship}/stage`).send({ stage: 'shipped', on: addDays(istDate(), -20) }).expect(200);
    await stores.post(`/api/imports/${id.ship}/stage`).send({ stage: 'at_port' }).expect(200);
    await stores.patch(`/api/imports/${id.ship}`).send({ boe_no: '4455667', boe_date: istDate() }).expect(200);
    const doc = (await stores.get(`/api/imports/${id.ship}`).expect(200)).body.data;
    expect(doc).toMatchObject({ stage: 'at_port', boe_no: '4455667', stage_dates: { pi: istDate(), shipped: addDays(istDate(), -20), at_port: istDate() } });
  });

  it('receives the cells; 1,980 pass QC at ₹84', async () => {
    const stores = await w.as('stores');
    const grn = (await stores.post('/api/purchasing/receipts').send({ purchase_order_id: id.po, lines: [{ po_line_id: id.poLine, received_qty: 2000 }] }).expect(201)).body.data;
    const line = (await stores.get(`/api/purchasing/receipts/${grn.id}`).expect(200)).body.data.lines[0];
    await stores.post(`/api/purchasing/receipts/${grn.id}/qc`).send({ lines: [{ grn_line_id: line.id, accepted_qty: 1980, rejected_qty: 20, reject_reason: 'Dented', batch_no: 'SZ-2611' }] }).expect(200);
    expect(await cellValue()).toEqual({ q: '1980.000', v: '166320.00' });
    // A tenth sold before the costs come in.
    await (await w.as('store')).post('/api/sales/quick-bill').send({
      customer: { name: 'Battery Works', phone: '9811000061' }, location_id: m.stores, lines: [{ item_id: id.cell, qty: 198 }], payments: [{ mode: 'cash', amount: 46728 }],
    }).expect(201);
  });
});

describe('its landed cost', () => {
  it('takes the forwarder\'s bill that names the shipment: to Landed Costs Clearing, its GST to input credit', async () => {
    const accounts = await w.as('accounts');
    const bill = await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.forwarder, supplier_invoice_no: 'PFM/889', bill_date: istDate(), import_shipment_id: id.ship,
      lines: [{ item_id: id.freight, qty: 1, rate: 16800, landed_kind: 'freight' }],
    }).expect(201);
    id.bill = bill.body.data.id;
    expect(bill.body.data.grand_total).toBe('19824.00');
    expect(await balance('landed_cost_clearing')).toBe(16800);
    expect(await balance('purchases')).toBe(0);
  });

  it('takes the duty paid on the bill of entry and the truck paid in cash; IGST is input credit', async () => {
    await (await w.as('stores')).post(`/api/imports/${id.ship}/costs`).send({ kind: 'bcd', amount: 8400, paid_from_account_id: m.account('bank') }).expect(403);
    const accounts = await w.as('accounts');
    const igstBefore = await balance('input_igst');
    for (const [kind, amount] of [['bcd', 8400], ['sws', 840], ['igst', 32000]] as const) {
      await accounts.post(`/api/imports/${id.ship}/costs`).send({ kind, amount, paid_from_account_id: m.account('bank'), description: 'Bill of entry 4455667' }).expect(201);
    }
    await accounts.post(`/api/imports/${id.ship}/costs`).send({ kind: 'inland', amount: 3500, basis: 'qty', paid_from_account_id: m.account('cash'), description: 'Truck from JNPT' }).expect(201);
    expect(await balance('landed_cost_clearing')).toBe(16800 + 8400 + 840 + 3500);
    expect(await balance('input_igst') - igstBefore).toBe(32000);
  });

  it('refuses to spread by weight until the cells have a weight', async () => {
    const accounts = await w.as('accounts');
    const doc = (await accounts.get(`/api/imports/${id.ship}`).expect(200)).body.data;
    const truck = doc.costs.find((c: any) => c.kind === 'inland');
    await accounts.patch(`/api/imports/${id.ship}/costs/${truck.id}`).send({ basis: 'weight' }).expect(200);
    const res = await accounts.get(`/api/imports/${id.ship}/preview`).expect(400);
    expect(res.body.error.message).toMatch(/Cell 21700 has no weight per unit/);
    await accounts.patch(`/api/imports/${id.ship}/costs/${truck.id}`).send({ basis: 'qty' }).expect(200);
  });

  it('spreads ₹29,540 over the cells: the share still held onto stock, the share sold to cost of goods sold', async () => {
    const accounts = await w.as('accounts');
    const preview = (await accounts.get(`/api/imports/${id.ship}/preview`).expect(200)).body.data;
    expect(preview).toMatchObject({ total: '29540.00' });
    expect(preview.items[0]).toMatchObject({ qty: '1980.000', amount: '29540.00', to_stock: '26586.00', to_cogs: '2954.00', per_unit: '14.92' });
    const cogs = await balance('cogs');
    await accounts.post(`/api/imports/${id.ship}/apply`).send({}).expect(200);
    expect(await balance('landed_cost_clearing')).toBe(0);
    expect(await balance('cogs') - cogs).toBe(2954);
    // 1,782 cells held: 1,782 x ₹84 = ₹1,49,688, and ₹26,586 more on top.
    expect(await cellValue()).toEqual({ q: '1782.000', v: '176274.00' });
    const doc = (await accounts.get(`/api/imports/${id.ship}`).expect(200)).body.data;
    expect(doc.goods[0]).toMatchObject({ landed: '29540.00', landed_each: '98.92' });
    await accounts.post(`/api/imports/${id.ship}/apply`).send({}).expect(409);
  });

  it('keeps applied costs as they are: they cannot change, and their bill cannot be cancelled', async () => {
    const accounts = await w.as('accounts');
    const doc = (await accounts.get(`/api/imports/${id.ship}`).expect(200)).body.data;
    const bcd = doc.costs.find((c: any) => c.kind === 'bcd');
    await accounts.patch(`/api/imports/${id.ship}/costs/${bcd.id}`).send({ basis: 'qty' }).expect(409);
    await accounts.delete(`/api/imports/${id.ship}/costs/${bcd.id}`).expect(409);
    const cancel = await accounts.post(`/api/purchasing/bills/${id.bill}/cancel`).send({ reason: 'Wrong' }).expect(409);
    expect(cancel.body.error.message).toMatch(/already on the goods/);
    await expectBooksHealthy(w);
  });
});

describe('supplier advances', () => {
  it('lists money paid out and not yet set against a bill, by age', async () => {
    const accounts = await w.as('accounts');
    await accounts.post('/api/payments').send({ direction: 'out', party_id: id.foreign, mode: 'bank_transfer', amount: 50000, paid_on: addDays(istDate(), -40), reference: 'TT advance' }).expect(201);
    await accounts.post('/api/payments').send({ direction: 'out', party_id: id.foreign, mode: 'bank_transfer', amount: 10000, paid_on: addDays(istDate(), -5) }).expect(201);
    const res = (await accounts.get('/api/imports/advances').expect(200)).body.data;
    expect(res).toEqual([expect.objectContaining({ supplier: 'Shenzhen Cells Co', days_0_30: '10000.00', days_31_90: '50000.00', over_90: null, total: '60000.00' })]);
    await (await w.as('sales')).get('/api/imports/advances').expect(403);
  });
});
