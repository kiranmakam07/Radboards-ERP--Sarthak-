import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, openingStock, setup, type World } from './helpers';

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

describe('0027 unit serials and batches', () => {
  const BPAN = 'IN0BAT48V20AH00000001';
  const units = (itemId: string) => rows<{ serial_no: string; status: string; location: string | null; sold_invoice_line_id: string | null }>(w.db, sql`
    select u.serial_no, u.status::text, l.name as location, u.sold_invoice_line_id from units u left join locations l on l.id = u.location_id
     where u.item_id = ${itemId} order by u.serial_no`);
  const stockAt = async (itemId: string, type: string) => Number((await rows<{ q: string }>(w.db, sql`
    select coalesce(sum(m.qty), 0)::text as q from stock_movements m join locations l on l.id = m.location_id where m.item_id = ${itemId} and l.type = ${type}`))[0]!.q);
  const unitsAt = async (itemId: string, type: string) => Number((await rows<{ n: string }>(w.db, sql`
    select count(*)::text as n from units u join locations l on l.id = u.location_id where u.item_id = ${itemId} and l.type = ${type}`))[0]!.n);

  beforeAll(async () => {
    const admin = await w.as('admin');
    const item = async (sku: string, type: string, extra: object = {}) =>
      (await admin.post('/api/items').send({ sku, name: sku, item_type: type, hsn_sac: '871160', gst_rate: 5, is_serialised: true, ...extra }).expect(201)).body.data.id as string;
    // Scooter: ₹84,000 retail with 5% GST (₹80,000 before GST), dealer ₹70,000, bought at ₹50,000.
    id.ev = await item('EV-X1', 'vehicle', { retail_price: 84000, dealer_price: 70000, purchase_cost: 50000 });
    id.bat = await item('BAT-X', 'sub_assembly', { retail_price: 21000, dealer_price: 18000, purchase_cost: 15000, charge_every_days: 30 });
    id.ctrl = await item('CTRL-X', 'sub_assembly');
    id.motor = await item('MTR-X', 'sub_assembly');
    id.supplier = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'EV Works', phone: '9700000031', gstin: gstin('27', 'EVWRK1234E') }).expect(201)).body.data.id;
    id.dealer = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Pune EV Dealer', phone: '9700000032', gstin: gstin('27', 'EVDLR1234D') }).expect(201)).body.data.id;
    const locs = await rows<{ id: string; type: string }>(w.db, sql`select id, type::text from locations`);
    id.stores = locs.find((l) => l.type === 'stores')!.id;
    id.showroom = locs.find((l) => l.type === 'showroom')!.id;
  });

  it('switches serial numbers on only while none is in stock', async () => {
    const admin = await w.as('admin');
    const res = await admin.patch(`/api/items/${id['EV-S1']}`).send({ is_serialised: true }).expect(400);
    expect(res.body.error.message).toMatch(/only while none of this item is in stock/);
  });

  it('QC gives each accepted unit its serial; rejected ones go back as a quantity', async () => {
    const stores = await w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.supplier, lines: [{ item_id: id.ev, qty: 3, rate: 50000 }] }).expect(201)).body.data;
    await stores.post(`/api/purchasing/orders/${po.id}/send`).send({}).expect(200);
    const doc = (await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data;
    const grn = (await stores.post('/api/purchasing/receipts').send({ purchase_order_id: po.id, lines: [{ po_line_id: doc.lines[0].id, received_qty: 3 }] }).expect(201)).body.data;
    const line = (await stores.get(`/api/purchasing/receipts/${grn.id}`).expect(200)).body.data.lines[0];
    const qc = (serials: string[]) => stores.post(`/api/purchasing/receipts/${grn.id}/qc`).send({
      lines: [{ grn_line_id: line.id, accepted_qty: 2, rejected_qty: 1, reject_reason: 'Scratched panel', serials, batch_no: 'b-oct-26', mfg_date: '2026-09-30' }],
    });
    expect((await qc(['EV001']).expect(400)).body.error.message).toMatch(/one serial for each of the 2 \(1 given\)/);
    expect((await qc(['EV001', 'ev001']).expect(400)).body.error.message).toMatch(/EV001 of EV-X1 is listed twice/);
    await qc(['ev001', 'EV002']).expect(200);
    expect(await units(id.ev!)).toEqual([
      expect.objectContaining({ serial_no: 'EV001', status: 'available', location: 'Stores' }),
      expect.objectContaining({ serial_no: 'EV002', status: 'available', location: 'Stores' }),
    ]);
    // One ledger row per unit, and the batch on each.
    const moves = await rows<{ qty: string; unit_id: string | null; batch_no: string | null }>(w.db, sql`
      select m.qty::text, m.unit_id, b.batch_no from stock_movements m left join batches b on b.id = m.batch_id where m.item_id = ${id.ev} order by m.id`);
    expect(moves.map((x) => [Number(x.qty), Boolean(x.unit_id), x.batch_no])).toEqual([[1, true, 'B-OCT-26'], [1, true, 'B-OCT-26'], [1, false, 'B-OCT-26']]);
    expect([await stockAt(id.ev!, 'stores'), await stockAt(id.ev!, 'rejected')]).toEqual([2, 1]);
  });

  it('opening stock of a serialised item names its serials; a count is refused', async () => {
    const stores = await w.as('stores');
    const open = (serials?: string[]) => stores.post('/api/stock/adjustments').send({
      kind: 'opening', location_id: id.stores, reason: 'Opening batteries', lines: [{ item_id: id.bat, qty_change: '2', unit_cost: '15000', serials }],
    });
    await open().expect(400);
    const adj = (await open(['BP1', 'BP2']).expect(201)).body.data;
    await (await w.as('admin')).post(`/api/stock/adjustments/${adj.id}/approve`).send({}).expect(200);
    expect((await units(id.bat!)).map((u) => [u.serial_no, u.status, u.location])).toEqual([['BP1', 'available', 'Stores'], ['BP2', 'available', 'Stores']]);
    const count = await stores.post('/api/stock/counts').send({ location_id: id.stores, reason: 'Month end', lines: [{ item_id: id.bat, counted_qty: 1 }] }).expect(400);
    expect(count.body.error.message).toMatch(/adjustment naming the serials, not a count/);
    // The same serial cannot come in twice.
    const again = (await open(['BP1', 'BP3']).expect(201)).body.data;
    const refused = await (await w.as('admin')).post(`/api/stock/adjustments/${again.id}/approve`).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/BAT-X BP1 is already in stock/);
  });

  it('a transfer moves named units', async () => {
    const stores = await w.as('stores');
    const move = (serials: string[], from = id.stores) => stores.post('/api/stock/transfers').send({
      from_location_id: from, to_location_id: id.showroom, reason: 'For the floor', lines: [{ item_id: id.ev, qty: 1, serials }],
    });
    await move(['EV001', 'EV002']).expect(400);
    expect((await move(['EV009']).expect(400)).body.error.message).toMatch(/no EV-X1 with serial EV009/);
    await move(['EV001']).expect(201);
    expect((await move(['EV001']).expect(409)).body.error.message).toMatch(/not at the place it is being moved from/);
    expect((await units(id.ev!)).map((u) => [u.serial_no, u.location])).toEqual([['EV001', 'Showroom'], ['EV002', 'Stores']]);
    expect([await stockAt(id.ev!, 'showroom'), await unitsAt(id.ev!, 'showroom')]).toEqual([1, 1]);
  });

  it('the quick bill sells by serial, and the serial goes on the bill', async () => {
    const store = await w.as('store');
    const bill = (serials?: string[]) => store.post('/api/sales/quick-bill').send({
      customer: { phone: '9811000099', name: 'Kiran' }, lines: [{ item_id: id.ev, qty: 1, serials }], payments: [{ mode: 'upi', amount: 84000 }],
    });
    expect((await bill().expect(400)).body.error.message).toMatch(/give one serial for each of the 1 \(0 given\)/);
    expect((await bill(['EV002']).expect(409)).body.error.message).toMatch(/EV-X1 EV002 is not at this place/);
    const res = (await bill(['EV001']).expect(201)).body.data;
    id.evInvoice = res.invoice.id;
    const doc = (await store.get(`/api/sales/invoices/${res.invoice.id}`).expect(200)).body.data;
    expect(doc.lines[0].serials).toEqual(['EV001']);
    const [ev001] = await units(id.ev!);
    expect(ev001).toMatchObject({ serial_no: 'EV001', status: 'sold', location: null, sold_invoice_line_id: doc.lines[0].id });
  });

  it('a delivery picks serials; without them it is refused', async () => {
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.ev, qty: 1 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
    await sales.post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(400);
    const lineId = (await sales.get(`/api/sales/orders/${order.id}`).expect(200)).body.data.lines[0].id;
    const d = (await sales.post(`/api/sales/orders/${order.id}/deliver`).send({ lines: [{ order_line_id: lineId, qty: 1, serials: ['EV002'] }] }).expect(201)).body.data;
    expect((await sales.get(`/api/sales/deliveries/${d.delivery.id}`).expect(200)).body.data.lines[0].serials).toEqual(['EV002']);
    const inv = (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({}).expect(201)).body.data;
    id.dealerInvoice = inv.id;
    expect((await sales.get(`/api/sales/invoices/${inv.id}`).expect(200)).body.data.lines[0].serials).toEqual(['EV002']);
  });

  it('a credit note brings a sold unit back by serial', async () => {
    const accounts = await w.as('accounts');
    const doc = (await accounts.get(`/api/sales/invoices/${id.evInvoice}`).expect(200)).body.data;
    const back = (serials: string[]) => accounts.post(`/api/sales/invoices/${id.evInvoice}/credit-note`).send({
      lines: [{ invoice_line_id: doc.lines[0].id, qty: 1, serials }], restock: true, reason: 'Changed mind',
    });
    expect((await back(['EV002']).expect(400)).body.error.message).toMatch(/EV002 was not sold on this invoice line/);
    await back(['EV001']).expect(201);
    expect((await units(id.ev!))[0]).toMatchObject({ serial_no: 'EV001', status: 'available', location: 'Showroom' });
  });

  it('cancelling a bill with restock brings its units back too', async () => {
    const cancelled = await (await w.as('accounts')).post(`/api/sales/invoices/${id.dealerInvoice}/cancel`).send({ reason: 'Wrong dealer', restock: true });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await units(id.ev!))[1]).toMatchObject({ serial_no: 'EV002', status: 'available', location: 'Showroom' });
    expect([await stockAt(id.ev!, 'showroom'), await unitsAt(id.ev!, 'showroom')]).toEqual([2, 2]);
  });

  it('records what a vehicle is made of, and walks it both ways', async () => {
    const stores = await w.as('stores');
    const ev001 = (await stores.get('/api/units?q=EV001').expect(200)).body.data[0];
    const add = async (parentId: string, itemId: string, serial: string, extra: object = {}) =>
      (await stores.post(`/api/units/${parentId}/components`).send({ item_id: itemId, serial_no: serial, ...extra }).expect(201)).body.data;
    const pack = await add(ev001.id, id.bat!, 'bp-in-1', { bpan: BPAN.toLowerCase(), batch_no: 'CELLS-7' });
    const ctrl = await add(pack.id, id.ctrl!, 'CT-1', { firmware_version: '2.4.1' });
    const motor = await add(ctrl.id, id.motor!, 'MT-1');
    expect(pack).toMatchObject({ serial_no: 'BP-IN-1', bpan: BPAN, status: 'available', location_id: null });

    const up = (await stores.get('/api/units/mt-1/genealogy').expect(200)).body.data;
    expect(up.ancestors.map((a: any) => [a.serial_no, a.depth])).toEqual([['CT-1', 1], ['BP-IN-1', 2], ['EV001', 3]]);
    const down = (await stores.get('/api/units/EV001/genealogy').expect(200)).body.data;
    expect(down.descendants.map((d: any) => [d.serial_no, d.depth])).toEqual([['BP-IN-1', 1], ['CT-1', 2], ['MT-1', 3]]);

    // A battery on the shelf is stock of its own: it is not "fitted" by a note.
    const bp1 = (await stores.get('/api/units?q=BP1').expect(200)).body.data[0];
    expect((await stores.patch(`/api/units/${bp1.id}`).send({ parent_unit_id: ev001.id }).expect(409)).body.error.message).toMatch(/on the shelf as stock of its own/);
    // No unit inside one of its own parts.
    await stores.patch(`/api/units/${pack.id}`).send({ parent_unit_id: motor.id }).expect(400);
    // Sales can look units up but not change them.
    await (await w.as('sales')).patch(`/api/units/${pack.id}`).send({ firmware_version: 'x' }).expect(403);

    // Where the vehicle goes, its parts go: to the demo fleet, all of them demo.
    await stores.post('/api/stock/transfers').send({ from_location_id: id.showroom, to_location_id: id.demo, reason: 'Test rides', lines: [{ item_id: id.ev, qty: 1, serials: ['EV001'] }] }).expect(201);
    const statuses = await rows<{ serial_no: string; status: string }>(w.db, sql`select serial_no, status::text from units where serial_no in ('EV001', 'BP-IN-1', 'CT-1', 'MT-1') order by serial_no`);
    expect(statuses.map((s) => s.status)).toEqual(['demo', 'demo', 'demo', 'demo']);
    const unit = (await stores.get(`/api/units/${ev001.id}`).expect(200)).body.data;
    expect(unit.events.map((e: any) => e.event)).toEqual(['moved', 'returned', 'sold', 'moved', 'received']);
  });

  it('tells the owner which batteries are late for their storage charge', async () => {
    const stores = await w.as('stores');
    const bp1 = (await stores.get('/api/units?q=BP1').expect(200)).body.data[0];
    await stores.post(`/api/units/${bp1.id}/charged`).send({ charged_on: addDays(istDate(), -31) }).expect(200);
    const due = (await (await w.as('owner')).get('/api/units/charge-due').expect(200)).body.data;
    expect(due.map((d: any) => [d.serial_no, d.days_late])).toEqual([['BP1', 1]]);
    expect((await (await w.as('owner')).get('/api/dashboards/overview').expect(200)).body.data.units).toEqual({ charge_due: 1 });
    await stores.post(`/api/units/${bp1.id}/charged`).send({}).expect(200);
    expect((await stores.get('/api/units/charge-due').expect(200)).body.data).toEqual([]);
  });

  it('a write-off scraps the named unit', async () => {
    const stores = await w.as('stores');
    const adj = (await stores.post('/api/stock/adjustments').send({
      kind: 'adjustment', location_id: id.stores, reason: 'Cell swelling', lines: [{ item_id: id.bat, qty_change: '-1', serials: ['BP2'] }],
    }).expect(201)).body.data;
    await (await w.as('admin')).post(`/api/stock/adjustments/${adj.id}/approve`).send({}).expect(200);
    expect((await units(id.bat!)).find((u) => u.serial_no === 'BP2')).toMatchObject({ status: 'scrapped', location: null });
  });

  it('keeps the history append-only, one unit per ledger row, units equal to stock, and the books balanced', async () => {
    await expect(w.db.execute(sql`update unit_events set note = 'x'`)).rejects.toThrow();
    await expect(w.db.execute(sql`delete from unit_events`)).rejects.toThrow();
    const [u] = await rows<{ id: string; item_id: string; location_id: string }>(w.db, sql`select id, item_id, location_id from units where serial_no = 'BP1'`);
    await expect(w.db.execute(sql`insert into stock_movements (item_id, location_id, qty, unit_cost, value, movement_type, ref_type, ref_id, unit_id)
      values (${u!.item_id}, ${u!.location_id}, 2, 1, 2, 'adjustment', 'test', gen_random_uuid(), ${u!.id})`)).rejects.toThrow();
    // Outside Rejected, the units at each place are exactly the stock there.
    const mismatch = await rows(w.db, sql`
      select m.item_id, m.location_id, sum(m.qty) as qty,
             (select count(*) from units x where x.item_id = m.item_id and x.location_id = m.location_id) as units
        from stock_movements m join items i on i.id = m.item_id join locations l on l.id = m.location_id
       where i.is_serialised and l.type <> 'rejected'
       group by m.item_id, m.location_id
      having sum(m.qty) <> (select count(*) from units x where x.item_id = m.item_id and x.location_id = m.location_id)`);
    expect(mismatch).toEqual([]);
    await expectBooksHealthy(w);
  });
});

describe('0028 stock reservations', () => {
  const onHandRow = async (sku: string) => (await (await w.as('stores')).get('/api/stock/on-hand?include_zero=true').expect(200)).body.data.find((r: any) => r.sku === sku);
  const order = async (lines: object[], extra: object = {}) => {
    const sales = await w.as('sales');
    const o = (await sales.post('/api/sales/orders').send({ channel: 'store', party_id: id.franchisee, lines, ...extra }).expect(201)).body.data;
    return (await sales.get(`/api/sales/orders/${o.id}`).expect(200)).body.data;
  };

  it('holds stock for an order: it is no longer available to anyone else', async () => {
    await openingStock(w, id.showroom!, [{ item_id: id['HLM-EV']!, qty_change: '5', unit_cost: '700' }]);
    const sales = await w.as('sales');
    const o = await order([{ item_id: id['HLM-EV'], qty: 3 }]);
    id.holdOrder = o.id;
    await sales.post(`/api/sales/orders/${o.id}/reservations`).send({ lines: [{ order_line_id: o.lines[0].id, qty: 3, location_id: id.showroom }], expires_on: addDays(istDate(), 7) }).expect(201);
    expect((await sales.post(`/api/sales/orders/${o.id}/reservations`).send({ lines: [{ order_line_id: o.lines[0].id, qty: 1, location_id: id.showroom }] }).expect(409)).body.error.message)
      .toMatch(/more HLM-EV than the order still needs/);
    const row = await onHandRow('HLM-EV');
    expect([Number(row.showroom_qty), Number(row.reserved_qty), Number(row.available_qty)]).toEqual([5, 3, 2]);
    const view = await rows<{ qty: string; reserved: string; available: string }>(w.db, sql`
      select qty::text, reserved::text, available::text from v_stock_on_hand where item_id = ${id['HLM-EV']} and location_id = ${id.showroom}`);
    expect(view[0]).toEqual({ qty: '5.000', reserved: '3.000', available: '2.000' });

    // The counter can sell the 2 that are free, not the 3 that are held.
    const store = await w.as('store');
    const sell = (qty: number) => store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id['HLM-EV'], qty }], payments: [{ mode: 'cash', amount: qty * 1050 }] });
    expect((await sell(3).expect(409)).body.error.message).toMatch(/Only 2.000 of HLM-EV is free here: 3.000 is reserved for other orders/);
    await sell(2).expect(201);
  });

  it('delivering the order uses up what was held for it', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/sales/orders/${id.holdOrder}/confirm`).send({}).expect(200);
    await sales.post(`/api/sales/orders/${id.holdOrder}/deliver`).send({ location_id: id.showroom }).expect(201);
    const o = (await sales.get(`/api/sales/orders/${id.holdOrder}`).expect(200)).body.data;
    expect(o.reservations.map((r: any) => r.status)).toEqual(['fulfilled']);
    expect(Number((await onHandRow('HLM-EV')).reserved_qty)).toBe(0);
  });

  it('holds a named unit: it cannot be sold to someone else or moved, until it is let go', async () => {
    const sales = await w.as('sales');
    const o = await order([{ item_id: id.ev, qty: 1 }]);
    const res = await sales.post(`/api/sales/orders/${o.id}/reservations`).send({ lines: [{ order_line_id: o.lines[0].id, qty: 1, location_id: id.showroom, serials: ['EV002'] }] }).expect(201);
    const [ev002] = await rows<{ status: string }>(w.db, sql`select status::text from units where serial_no = 'EV002'`);
    expect(ev002!.status).toBe('reserved');
    const quick = await (await w.as('store')).post('/api/sales/quick-bill').send({ lines: [{ item_id: id.ev, qty: 1, serials: ['EV002'] }], payments: [{ mode: 'upi', amount: 84000 }] }).expect(409);
    expect(quick.body.error.message).toMatch(/EV-X1 EV002 is reserved for another order/);
    await (await w.as('stores')).post('/api/stock/transfers').send({ from_location_id: id.showroom, to_location_id: id.stores, reason: 'Back', lines: [{ item_id: id.ev, qty: 1, serials: ['EV002'] }] }).expect(409);

    await sales.post(`/api/sales/reservations/${res.body.data[0].id}/release`).send({}).expect(200);
    expect((await rows<{ status: string }>(w.db, sql`select status::text from units where serial_no = 'EV002'`))[0]!.status).toBe('available');

    // Held again, then the hold runs out: the next reservation or delivery lets it go.
    await sales.post(`/api/sales/orders/${o.id}/reservations`).send({ lines: [{ order_line_id: o.lines[0].id, qty: 1, location_id: id.showroom, serials: ['EV002'] }], expires_on: istDate() }).expect(201);
    await w.db.execute(sql`update stock_reservations set expires_on = ${addDays(istDate(), -1)}::date where status = 'open' and unit_id is not null`);
    // (a demo unit can be held for a customer too)
    const other = await order([{ item_id: id.ev, qty: 1 }]);
    await sales.post(`/api/sales/orders/${other.id}/reservations`).send({ lines: [{ order_line_id: other.lines[0].id, qty: 1, location_id: id.demo, serials: ['EV001'] }] }).expect(201);
    expect((await rows<{ status: string }>(w.db, sql`select status::text from units where serial_no = 'EV002'`))[0]!.status).toBe('available');

    // Cancelling an order lets its holds go.
    await sales.post(`/api/sales/orders/${o.id}/reservations`).send({ lines: [{ order_line_id: o.lines[0].id, qty: 1, location_id: id.showroom, serials: ['EV002'] }] }).expect(201);
    await sales.post(`/api/sales/orders/${o.id}/cancel`).send({ reason: 'Customer went elsewhere' }).expect(200);
    expect((await sales.get(`/api/sales/orders/${o.id}`).expect(200)).body.data.reservations.map((r: any) => r.status)).toEqual(['released', 'expired', 'released']);
    expect((await rows<{ status: string }>(w.db, sql`select status::text from units where serial_no = 'EV002'`))[0]!.status).toBe('available');
  });
});

describe('0029 legal entities and branches', () => {
  it('starts with one entity, the company profile, and keeps the two the same', async () => {
    const admin = await w.as('admin');
    const list = (await admin.get('/api/masters/entities').expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ legal_name: 'Radboards Pvt Ltd', state_code: '27', is_default: true, code: null });
    await admin.put('/api/settings/company').send({
      name: 'Radboards', legal_name: 'Radboards Private Limited', gstin: gstin('27', 'AAPFU0939F'), state_code: '27', address: { line1: '1 Test Road', city: 'Pune' },
    }).expect(200);
    expect((await admin.get('/api/masters/entities').expect(200)).body.data[0]).toMatchObject({ legal_name: 'Radboards Private Limited', gstin: gstin('27', 'AAPFU0939F') });
    // Every existing document belongs to it.
    const strays = await rows(w.db, sql`
      select 'invoices' as t from invoices where entity_id <> rc_default_entity() union all
      select 'journal' from journal_entries where entity_id <> rc_default_entity() union all
      select 'orders' from sales_orders where entity_id <> rc_default_entity()`);
    expect(strays).toEqual([]);
  });

  it('a second entity sells under its own name, state and numbers, in its own books', async () => {
    const admin = await w.as('admin');
    await admin.post('/api/masters/entities').send({ legal_name: 'Radboards EV Karnataka LLP', state_code: '29', gstin: gstin('29', 'RBKAR1234K'), code: 'bb' }).expect(400);
    const ka = (await admin.post('/api/masters/entities').send({ legal_name: 'Radboards EV Karnataka LLP', state_code: '29', gstin: gstin('29', 'RBKAR1234K'), code: 'k' }).expect(201)).body.data;
    await admin.post(`/api/masters/entities/${ka.id}/branches`).send({ name: 'Bengaluru showroom', state_code: '29' }).expect(201);
    expect((await admin.get('/api/masters/entities').expect(200)).body.data[1].branches.map((b: any) => b.name)).toEqual(['Bengaluru showroom']);

    // The Karnataka company sells to the Maharashtra franchisee: that is inter-state for it (IGST).
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', entity_id: ka.id, party_id: id.franchisee, lines: [{ item_id: id['GRS-1'], qty: 1 }] }).expect(201)).body.data;
    expect(order.order_no).toMatch(/^KSO\/\d\d-\d\d\/00001$/);
    await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
    await openingStock(w, id.stores!, [{ item_id: id['GRS-1']!, qty_change: '5', unit_cost: '700' }]);
    await sales.post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(201);
    const inv = (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({}).expect(201)).body.data;
    expect(inv.invoice_no).toMatch(/^KINV\/\d\d-\d\d\/00001$/);
    expect(inv.invoice_no.length).toBeLessThanOrEqual(16);
    expect(Number(inv.igst_total)).toBeGreaterThan(0);
    const doc = (await sales.get(`/api/sales/invoices/${inv.id}`).expect(200)).body.data;
    expect(doc.company).toMatchObject({ name: 'Radboards EV Karnataka LLP', state_code: '29', gstin: gstin('29', 'RBKAR1234K') });
    const [je] = await rows<{ entity_id: string }>(w.db, sql`select entity_id from journal_entries where ref_type = 'invoice' and ref_id = ${inv.id}`);
    expect(je!.entity_id).toBe(ka.id);
    // The first company's numbering carries on by itself.
    const series = await rows<{ doc_type: string; prefix: string }>(w.db, sql`select doc_type, prefix from number_series where doc_type = 'invoice' order by prefix`);
    expect(series.map((s) => s.prefix.split('/')[0])).toEqual(['INV', 'KINV']);
  });
});

describe('0030 GST rate history', () => {
  it('each line takes the rate in force on its document date, the longest HSN first', async () => {
    const admin = await w.as('admin');
    const sales = await w.as('sales');
    const today = istDate();
    await (await w.as('sales')).post('/api/masters/tax-rates').send({ hsn: '8711', gst_rate: 18, effective_from: today }).expect(403);
    await admin.post('/api/masters/tax-rates').send({ hsn: '8711', gst_rate: 10, effective_from: today }).expect(400);
    // Two-wheelers (8711) go to 18% from tomorrow; electric ones (871160) to 12% from today.
    await admin.post('/api/masters/tax-rates').send({ hsn: '8711', gst_rate: 18, effective_from: addDays(today, 1), note: 'Rate notification' }).expect(201);
    await admin.post('/api/masters/tax-rates').send({ hsn: '871160', gst_rate: 12, cess_rate: 1, effective_from: today }).expect(201);
    const rate = async (date: string) => {
      const o = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.franchisee, order_date: date, lines: [{ item_id: id['GRS-1'], qty: 1 }] }).expect(201)).body.data;
      const line = (await sales.get(`/api/sales/orders/${o.id}`).expect(200)).body.data.lines[0];
      return { id: o.id, gst: Number(line.gst_rate), cess: Number(line.cess_rate) };
    };
    const yesterday = await rate(addDays(today, -1));
    expect([yesterday.gst, yesterday.cess]).toEqual([5, 0]); // the item's own rate: no row in force yet
    const now = await rate(today);
    expect([now.gst, now.cess]).toEqual([12, 1]); // 871160 beats 8711
    // Ordered yesterday at 5%, billed today: the bill charges today's 12% + 1%.
    await sales.post(`/api/sales/orders/${yesterday.id}/confirm`).send({}).expect(200);
    await sales.post(`/api/sales/orders/${yesterday.id}/deliver`).send({}).expect(201);
    const inv = (await sales.post(`/api/sales/orders/${yesterday.id}/invoice`).send({}).expect(201)).body.data;
    const doc = (await sales.get(`/api/sales/invoices/${inv.id}`).expect(200)).body.data;
    expect([Number(doc.lines[0].gst_rate), Number(doc.lines[0].cess_rate)]).toEqual([12, 1]);
    // And a purchase order dated today buys at it too.
    const stores = await w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.supplier, lines: [{ item_id: id['GRS-1'], qty: 1, rate: 700 }] }).expect(201)).body.data;
    expect(Number((await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines[0].gst_rate)).toBe(12);
    expect((await admin.get('/api/masters/tax-rates').expect(200)).body.data.map((r: any) => [r.hsn, Number(r.gst_rate)])).toEqual([['8711', 18], ['871160', 12]]);
  });
});

describe('0031 currency and exchange differences', () => {
  const forex = async () => Number((await rows<{ b: string }>(w.db, sql`
    select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'forex_gain_loss'`))[0]!.b);
  const outstanding = async (billId: string) => Number((await rows<{ o: string }>(w.db, sql`select outstanding::text as o from v_bill_outstanding where bill_id = ${billId}`))[0]!.o);

  it('a PO and a bill in dollars are kept in rupees at their own rates', async () => {
    const admin = await w.as('admin');
    const stores = await w.as('stores');
    const accounts = await w.as('accounts');
    id.cell = (await admin.post('/api/items').send({ sku: 'CELL-21700', name: 'Cell 21700', item_type: 'raw_material', hsn_sac: '850760', gst_rate: 0 }).expect(201)).body.data.id;
    id.importer = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Shenzhen Cells', phone: '9700000041' }).expect(201)).body.data.id;
    await stores.post('/api/purchasing/orders').send({ supplier_id: id.importer, currency: 'USD', lines: [{ item_id: id.cell, qty: 10, rate: 100 }] }).expect(400);
    // $100 a cell at ₹83 = ₹8,300.
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.importer, currency: 'usd', fx_rate: '83', lines: [{ item_id: id.cell, qty: 10, rate: 100 }] }).expect(201)).body.data;
    expect(po).toMatchObject({ currency: 'USD', fx_rate: '83.000000' });
    await stores.post(`/api/purchasing/orders/${po.id}/send`).send({}).expect(200);
    const poDoc = (await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data;
    expect(poDoc.lines[0].rate).toBe('8300.00');
    id.importPo = po.id; id.importPoLine = poDoc.lines[0].id;
    // The supplier's invoice: $1,000 for the 10, booked on its day at ₹84 = ₹84,000.
    const bill = (await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.importer, purchase_order_id: po.id, supplier_invoice_no: 'SZ-001', bill_date: istDate(), currency: 'USD', fx_rate: '84',
      lines: [{ po_line_id: id.importPoLine, qty: 10, rate: 100 }],
    }).expect(201)).body.data;
    expect(bill).toMatchObject({ currency: 'USD', grand_total: '84000.00' });
    id.usdBill = bill.id;
  });

  it('paying it at another rate books the difference to Foreign Exchange Gain / Loss', async () => {
    const accounts = await w.as('accounts');
    const pay = (body: object) => accounts.post('/api/payments').send({ direction: 'out', party_id: id.importer, mode: 'bank_transfer', paid_on: istDate(), ...body });
    expect((await pay({ amount: 85000, allocations: [{ purchase_bill_id: id.usdBill, amount: 85000 }] }).expect(400)).body.error.message).toMatch(/is in USD: pay it in USD/);
    await accounts.post('/api/payments').send({ direction: 'in', party_id: id.franchisee, mode: 'bank_transfer', amount: 100, currency: 'USD', fx_rate: '84' }).expect(400);
    // $1,000 paid at ₹85 = ₹85,000 from the bank; the bill was ₹84,000: a ₹1,000 loss.
    const p = (await pay({ amount: 85000, currency: 'USD', fx_rate: '85', allocations: [{ purchase_bill_id: id.usdBill, amount: 85000 }] }).expect(201)).body.data;
    expect(await outstanding(id.usdBill!)).toBe(0);
    expect(await forex()).toBe(1000);
    const doc = (await accounts.get(`/api/payments/${p.id}`).expect(200)).body.data;
    expect(doc.allocations[0]).toMatchObject({ amount: '85000.00', fx_difference: '-1000.00' });
    // The supplier is square: billed ₹84,000, settled ₹84,000.
    const [bal] = await rows<{ b: string }>(w.db, sql`select coalesce(sum(debit) - sum(credit), 0)::text as b from journal_lines where party_id = ${id.importer}`);
    expect(Number(bal!.b)).toBe(0);
  });

  it('a part payment at a better rate is a gain, and cancelling it takes the gain back', async () => {
    const accounts = await w.as('accounts');
    const stores = await w.as('stores');
    const po = (await stores.post('/api/purchasing/orders').send({ supplier_id: id.importer, currency: 'USD', fx_rate: '84', lines: [{ item_id: id.cell, qty: 5, rate: 100 }] }).expect(201)).body.data;
    await stores.post(`/api/purchasing/orders/${po.id}/send`).send({}).expect(200);
    const line = (await stores.get(`/api/purchasing/orders/${po.id}`).expect(200)).body.data.lines[0];
    const bill = (await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.importer, purchase_order_id: po.id, supplier_invoice_no: 'SZ-002', bill_date: istDate(), currency: 'USD', fx_rate: '84',
      lines: [{ po_line_id: line.id, qty: 5, rate: 100 }],
    }).expect(201)).body.data;
    // $200 at ₹82 = ₹16,400 paid; it clears $200 of the bill at ₹84 = ₹16,800: ₹400 gained.
    const p = (await accounts.post('/api/payments').send({
      direction: 'out', party_id: id.importer, mode: 'bank_transfer', amount: 16400, currency: 'USD', fx_rate: '82', allocations: [{ purchase_bill_id: bill.id, amount: 16400 }],
    }).expect(201)).body.data;
    expect(await outstanding(bill.id)).toBe(42000 - 16800);
    expect(await forex()).toBe(1000 - 400);
    await accounts.post(`/api/payments/${p.id}/cancel`).send({ reason: 'Wrong rate' }).expect(200);
    expect(await outstanding(bill.id)).toBe(42000);
    expect(await forex()).toBe(1000);
    await expectBooksHealthy(w);
  });
});

describe('0032 e-invoice fields', () => {
  const IRN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
  /** The database's own answer to an UPDATE: null if it went through, else its message. */
  const tryUpdate = async (statement: string) => {
    try {
      await w.db.execute(sql.raw(statement));
      return null;
    } catch (e) {
      const err = e as Error & { cause?: { message?: string } };
      return `${err.message} ${err.cause?.message ?? ''}`;
    }
  };

  it('an issued invoice takes its IRN, acknowledgement, QR and e-way bill', async () => {
    const accounts = await w.as('accounts');
    const [inv] = await rows<{ id: string }>(w.db, sql`select id from invoices where status = 'issued' and doc_type = 'tax_invoice' order by created_at limit 1`);
    id.einv = inv!.id;
    await accounts.put(`/api/sales/invoices/${id.einv}/e-invoice`).send({ irn: 'short' }).expect(400);
    await (await w.as('sales')).put(`/api/sales/invoices/${id.einv}/e-invoice`).send({ irn: IRN }).expect(403);
    const res = await accounts.put(`/api/sales/invoices/${id.einv}/e-invoice`).send({
      irn: IRN.toUpperCase(), irn_ack_no: '112410000012345', irn_ack_date: '2026-10-22T10:15:00+05:30', signed_qr: 'eyJhbGciOi...', irn_status: 'generated',
      eway_bill_no: '351000012345', eway_valid_until: '2026-10-24T23:59:00+05:30',
    }).expect(200);
    expect(res.body.data).toMatchObject({ irn: IRN, irn_ack_no: '112410000012345', irn_status: 'generated', eway_bill_no: '351000012345' });
  });

  it('every other column of an issued invoice stays locked, even with direct database access', async () => {
    const open = new Set(['irn', 'irn_ack_no', 'irn_ack_date', 'signed_qr', 'irn_status', 'irn_cancelled_at', 'eway_bill_no', 'eway_valid_until',
      'updated_at', 'status', 'cancelled_at', 'cancel_reason']);
    const cols = await rows<{ column_name: string; data_type: string; udt_name: string; character_maximum_length: number | null }>(w.db, sql`
      select column_name, data_type, udt_name, character_maximum_length from information_schema.columns
       where table_name = 'invoices' and table_schema = current_schema() order by ordinal_position`);
    const locked = cols.filter((c) => !open.has(c.column_name));
    expect(locked.length).toBeGreaterThanOrEqual(30);
    // For each column, a value that is certainly different from what is there.
    const changed = (c: (typeof cols)[number]) => {
      const q = `"${c.column_name}"`;
      switch (c.data_type) {
        case 'numeric': case 'integer': case 'bigint': case 'smallint': return `coalesce(${q}, 0) + 1`;
        case 'date': return `coalesce(${q}, current_date) + 1`;
        case 'timestamp with time zone': return `coalesce(${q}, now()) + interval '1 day'`;
        case 'boolean': return `not coalesce(${q}, false)`;
        case 'uuid': return 'gen_random_uuid()';
        case 'jsonb': return `'{"changed": true}'::jsonb`;
        case 'character': return `case when ${q} = repeat('9', ${c.character_maximum_length}) then repeat('8', ${c.character_maximum_length}) else repeat('9', ${c.character_maximum_length}) end`;
        case 'USER-DEFINED': return `(select e.enumlabel::${c.udt_name} from pg_enum e join pg_type t on t.oid = e.enumtypid
                                       where t.typname = '${c.udt_name}' and e.enumlabel <> coalesce(${q}::text, '') limit 1)`;
        default: return `coalesce(${q}::text, '') || 'x'`;
      }
    };
    const leaks: string[] = [];
    for (const c of locked) {
      const answer = await tryUpdate(`update invoices set "${c.column_name}" = ${changed(c)} where id = '${id.einv}'`);
      if (!answer || !/issued invoice .* is immutable/.test(answer)) leaks.push(`${c.column_name}: ${answer ?? 'changed'}`);
    }
    expect(leaks).toEqual([]);
    // And the open ones really are open.
    expect(await tryUpdate(`update invoices set eway_bill_no = '351000099999', irn_status = 'generated' where id = '${id.einv}'`)).toBeNull();
  });

  it('a cancelled invoice can still have its IRN cancellation recorded, and nothing else', async () => {
    const [inv] = await rows<{ id: string }>(w.db, sql`select id from invoices where status = 'cancelled' order by created_at limit 1`);
    expect(inv).toBeTruthy();
    expect(await tryUpdate(`update invoices set irn_status = 'cancelled', irn_cancelled_at = now() where id = '${inv!.id}'`)).toBeNull();
    expect(await tryUpdate(`update invoices set notes = 'x' where id = '${inv!.id}'`)).toMatch(/cancelled invoice .* cannot change/);
    expect(await tryUpdate(`update invoices set status = 'issued' where id = '${inv!.id}'`)).toMatch(/cancelled invoice .* cannot change/);
    expect(await tryUpdate(`delete from invoices where id = '${inv!.id}'`)).toMatch(/legal record and cannot be deleted/);
  });
});
