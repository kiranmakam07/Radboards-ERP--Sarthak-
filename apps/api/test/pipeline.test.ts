import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { deliveryChecksDone, expectBooksHealthy, masters, setup, type World } from './helpers';

/**
 * The sales pipeline for vehicles (P2 of the brief): test rides on demo units, a booking (an order, an advance,
 * the scooter held by serial), and the delivery checklist that must be done before a vehicle goes out.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const slot = (hour: number, minute = 0) => `${addDays(istDate(), 1)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`;
const leadStage = async (leadId: string | undefined) => (await rows<{ stage: string }>(w.db, sql`select stage::text from leads where id = ${leadId}`))[0]!.stage;
const unitStatus = async (serial: string) => (await rows<{ status: string }>(w.db, sql`select status::text from units where serial_no = ${serial}`))[0]!.status;

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  id.demoPlace = (await admin.post('/api/masters/locations').send({ name: 'Demo fleet', type: 'demo' }).expect(201)).body.data.id;
  id.scooter = (await admin.post('/api/items').send({ sku: 'EV-S1', name: 'Scooter S1', item_type: 'vehicle', hsn_sac: '871160', gst_rate: 5, retail_price: 89250, purchase_cost: 62000, is_serialised: true }).expect(201)).body.data.id;
  const stores = await w.as('stores');
  for (const [where, serials] of [[id.demoPlace, ['SC-D1']], [m.showroom, ['SC-10', 'SC-11']]] as const) {
    const adj = await stores.post('/api/stock/adjustments').send({ kind: 'opening', location_id: where, reason: 'Opening', lines: [{ item_id: id.scooter, qty_change: String(serials.length), unit_cost: '62000', serials }] }).expect(201);
    await admin.post(`/api/stock/adjustments/${adj.body.data.id}/approve`).send({}).expect(200);
  }
  const sales = await w.as('sales');
  const lead = async (name: string, phone: string) => (await sales.post('/api/leads').send({ name, phone, source_id: m.source('Walk-in') }).expect(201)).body.data.id as string;
  id.asha = await lead('Asha Rao', '9820011101');
  id.vikram = await lead('Vikram Shah', '9820011102');
});
afterAll(() => w.close());

describe('test rides', () => {
  it('books a demo unit for a slot and moves the lead to test ride booked', async () => {
    const sales = await w.as('sales');
    const units = (await sales.get('/api/pipeline/demo-units').expect(200)).body.data;
    expect(units.map((u: any) => u.serial_no)).toEqual(['SC-D1']);
    id.demoUnit = units[0].id;
    const ride = await sales.post(`/api/pipeline/leads/${id.asha}/test-rides`).send({ unit_id: id.demoUnit, slot_at: slot(11) }).expect(201);
    id.ride = ride.body.data.id;
    expect(await leadStage(id.asha)).toBe('test_ride_booked');
  });

  it('never books the same demo unit twice at the same time, and only demo units', async () => {
    const sales = await w.as('sales');
    const clash = await sales.post(`/api/pipeline/leads/${id.vikram}/test-rides`).send({ unit_id: id.demoUnit, slot_at: slot(11, 15) }).expect(409);
    expect(clash.body.error.message).toMatch(/SC-D1 is already booked for a test ride then/);
    await sales.post(`/api/pipeline/leads/${id.vikram}/test-rides`).send({ unit_id: id.demoUnit, slot_at: slot(11, 30) }).expect(201);
    const showroom = (await rows<{ id: string }>(w.db, sql`select id from units where serial_no = 'SC-10'`))[0]!.id;
    const notDemo = await sales.post(`/api/pipeline/leads/${id.vikram}/test-rides`).send({ unit_id: showroom, slot_at: slot(15) }).expect(409);
    expect(notDemo.body.error.message).toMatch(/SC-10 is not a demo unit/);
  });

  it('moves the lead to test ride done once ridden; the event stages are not set by hand', async () => {
    const sales = await w.as('sales');
    const byHand = await sales.post(`/api/leads/${id.asha}/stage`).send({ stage: 'booked' }).expect(409);
    expect(byHand.body.error.message).toMatch(/cannot move/);
    await sales.post(`/api/pipeline/test-rides/${id.ride}/outcome`).send({ outcome: 'done', notes: 'Liked the pickup' }).expect(200);
    expect(await leadStage(id.asha)).toBe('test_ride_done');
    await sales.post(`/api/pipeline/test-rides/${id.ride}/outcome`).send({ outcome: 'no_show' }).expect(409);
    await sales.post(`/api/leads/${id.asha}/stage`).send({ stage: 'quoted', next_follow_up_at: `${addDays(istDate(), 2)}T10:00:00+05:30` }).expect(200);
  });
});

describe('a booking, and the delivery checklist', () => {
  it('books the scooter: a confirmed order, the serial held for it, the advance received', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/pipeline/leads/${id.asha}/booking`).send({ item_id: id.scooter, serial: 'SC-10', location_id: m.showroom, advance: { mode: 'upi', amount: 0 } }).expect(400);
    const res = await sales.post(`/api/pipeline/leads/${id.asha}/booking`).send({ item_id: id.scooter, serial: 'sc-10', location_id: m.showroom, advance: { mode: 'upi', amount: 10000 } }).expect(201);
    id.order = res.body.data.order.id;
    expect(res.body.data.order.status).toBe('confirmed');
    expect(await unitStatus('SC-10')).toBe('reserved');
    expect(await leadStage(id.asha)).toBe('booked');
    const [advance] = await rows<{ amount: string; allocated: number }>(w.db, sql`
      select p.amount::text, (select count(*)::int from payment_allocations a where a.payment_id = p.id) as allocated from payments p where p.id = ${res.body.data.payment.id}`);
    expect(advance).toEqual({ amount: '10000.00', allocated: 0 });
    // The scooter is held: no one else can book it.
    const taken = await sales.post(`/api/pipeline/leads/${id.vikram}/booking`).send({ item_id: id.scooter, serial: 'SC-10', location_id: m.showroom, advance: { mode: 'cash', amount: 5000 } }).expect(409);
    expect(taken.body.error.message).toMatch(/SC-10 is reserved/);
  });

  it('will not hand the scooter over until every check is done', async () => {
    const sales = await w.as('sales');
    const order = (await sales.get(`/api/sales/orders/${id.order}`).expect(200)).body.data;
    const deliver = () => sales.post(`/api/sales/orders/${id.order}/deliver`).send({ location_id: m.showroom, lines: [{ order_line_id: order.lines[0].id, qty: 1, serials: ['SC-10'] }] });
    const none = await deliver().expect(409);
    expect(none.body.error.message).toMatch(/Still to do: the pre-delivery inspection, the rider briefing, the warranty registration, a photo at delivery, the signed delivery note/);
    await sales.put(`/api/sales/orders/${id.order}/delivery-checks`).send({ pdi_done: true, rider_briefing: true }).expect(200);
    const some = await deliver().expect(409);
    expect(some.body.error.message).toMatch(/Still to do: the warranty registration, a photo at delivery, the signed delivery note\.$/);
    const done = await deliveryChecksDone(w, 'sales');
    await (await w.as('sales')).put(`/api/sales/orders/${id.order}/delivery-checks`).send(done).expect(200);
    await deliver().expect(201);
    expect(await unitStatus('SC-10')).toBe('sold');
    expect(await leadStage(id.asha)).toBe('delivered');
  });

  it('asks the counter for the checklist when it sells a vehicle in a quick bill', async () => {
    const store = await w.as('store');
    const bill = { customer: { name: 'Neha Kulkarni', phone: '9820011103' }, lines: [{ item_id: id.scooter, qty: 1, serials: ['SC-11'] }], payments: [{ mode: 'upi', amount: 89250 }] };
    const refused = await store.post('/api/sales/quick-bill').send(bill).expect(409);
    expect(refused.body.error.message).toMatch(/Scooter S1 is a vehicle: it is handed over once its delivery checklist is done/);
    const checks = await deliveryChecksDone(w, 'store');
    await store.post('/api/sales/quick-bill').send({ ...bill, delivery_checks: checks }).expect(201);
    await expectBooksHealthy(w);
  });
});
