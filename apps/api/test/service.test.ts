import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, formatDate, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, setup, type World } from './helpers';

/**
 * Service and warranty (P2 of the brief), with figures worked out by hand.
 *
 *   Scooter:      retail ₹84,000 with 5% GST, 24 months' warranty or 20,000 km.
 *   Battery pack: costs ₹15,000, 36 months' warranty of its own.
 *   Brake pad:    retail ₹590 with GST (₹500 + ₹90), costs ₹200.
 *   Labour:       ₹1,180 an hour with GST (₹1,000 + ₹180).
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const today = istDate();

const balance = async (key: string, partyId?: string) => Number((await rows<{ b: string }>(w.db, sql`
  select coalesce(sum(l.debit) - sum(l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
   where a.system_key = ${key} and (${partyId ?? null}::uuid is null or l.party_id = ${partyId ?? null}::uuid)`))[0]!.b);
const unit = async (serial: string) => (await rows<{ id: string; status: string; parent: string | null }>(w.db, sql`
  select u.id, u.status::text, p.serial_no as parent from units u left join units p on p.id = u.parent_unit_id where u.serial_no = ${serial}`))[0]!;
const atBay = async (itemId: string | undefined) => Number((await rows<{ q: string }>(w.db, sql`
  select coalesce(sum(qty), 0)::text as q from stock_movements where item_id = ${itemId} and location_id = ${id.bay}`))[0]!.q);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  id.bay = (await admin.post('/api/masters/locations').send({ name: 'Workshop', type: 'service_bay' }).expect(201)).body.data.id;
  const item = async (body: object) => (await admin.post('/api/items').send(body).expect(201)).body.data.id as string;
  id.scooter = await item({ sku: 'EV-S1', name: 'Scooter S1', item_type: 'vehicle', hsn_sac: '871160', gst_rate: 5, retail_price: 84000, purchase_cost: 60000, is_serialised: true });
  id.pack = await item({ sku: 'BAT-60', name: 'Battery Pack 60V', item_type: 'sub_assembly', hsn_sac: '850760', gst_rate: 18, retail_price: 23600, purchase_cost: 15000, is_serialised: true });
  id.pad = await item({ sku: 'BRK-PAD', name: 'Brake Pad', item_type: 'spare_part', hsn_sac: '870830', gst_rate: 18, retail_price: 590, purchase_cost: 200 });
  id.labour = await item({ sku: 'LAB-HR', name: 'Workshop labour (hour)', item_type: 'service', hsn_sac: '998714', gst_rate: 18, retail_price: 1180 });
  id.supplier = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Cell Power Ltd', phone: '9700000051', gstin: gstin('27', 'CELLP1234C') }).expect(201)).body.data.id;
  id.customer = (await admin.post('/api/parties').send({ party_type: 'customer', name: 'Anita Desai', phone: '9811000051' }).expect(201)).body.data.id;

  const manager = await w.as('service_manager');
  await (await w.as('technician')).post('/api/service/warranty-rules').send({ item_id: id.scooter, months: 24 }).expect(403);
  await manager.post('/api/service/warranty-rules').send({ item_id: id.scooter, months: 24, km_limit: 20000 }).expect(201);
  await manager.post('/api/service/warranty-rules').send({ item_id: id.pack, months: 36 }).expect(201);
  id.fault = (await manager.post('/api/service/fault-codes').send({ code: 'bms-02', component: 'Battery', description: 'Cell imbalance' }).expect(201)).body.data.id;

  // Two scooters sold: SC-1 thirteen months ago (in warranty, its pack inside it), SC-2 thirty months ago (out of it).
  const stores = await w.as('stores');
  const scooters = await stores.post('/api/stock/adjustments').send({
    kind: 'opening', location_id: m.showroom, reason: 'Opening', lines: [{ item_id: id.scooter, qty_change: '2', unit_cost: '60000', serials: ['SC-1', 'SC-2'] }],
  }).expect(201);
  await admin.post(`/api/stock/adjustments/${scooters.body.data.id}/approve`).send({}).expect(200);
  await (await w.as('store')).post('/api/sales/quick-bill').send({ party_id: id.customer, lines: [{ item_id: id.scooter, qty: 2, serials: ['SC-1', 'SC-2'] }], payments: [{ mode: 'upi', amount: 168000 }] }).expect(201);
  await stores.post(`/api/units/${(await unit('SC-1')).id}/components`).send({ item_id: id.pack, serial_no: 'BP-OLD', batch_no: 'CELLS-9' }).expect(201);
  await w.db.execute(sql`update units set sold_on = ${addMonths(today, -13)}::date where serial_no in ('SC-1', 'BP-OLD')`);
  await w.db.execute(sql`update units set sold_on = ${addMonths(today, -30)}::date where serial_no = 'SC-2'`);
  await w.db.execute(sql`update batches set supplier_id = ${id.supplier} where batch_no = 'CELLS-9'`);
  // The workshop shelf: one spare pack and ten brake pads.
  const shelf = await stores.post('/api/stock/adjustments').send({
    kind: 'opening', location_id: id.bay, reason: 'Workshop stock', lines: [
      { item_id: id.pack, qty_change: '1', unit_cost: '15000', serials: ['BP-NEW'] }, { item_id: id.pad, qty_change: '10', unit_cost: '200' },
    ],
  }).expect(201);
  await admin.post(`/api/stock/adjustments/${shelf.body.data.id}/approve`).send({}).expect(200);
});
afterAll(() => w.close());

describe('warranty, checked by itself', () => {
  it('from the sale date and the rule, for the unit and each component inside it', async () => {
    const tech = await w.as('technician');
    const res = await tech.get('/api/service/warranty?serial=sc-1').expect(200);
    expect(res.body.data.map((x: any) => [x.serial_no, x.valid, x.until])).toEqual([
      ['SC-1', true, addMonths(addMonths(today, -13), 24)], ['BP-OLD', true, addMonths(addMonths(today, -13), 36)],
    ]);
    const old = await tech.get('/api/service/warranty?serial=SC-2').expect(200);
    expect(old.body.data[0]).toMatchObject({ valid: false, reason: `Ended on ${formatDate(addMonths(addMonths(today, -30), 24))}` });
    const far = await tech.get('/api/service/warranty?serial=SC-1&km=25000').expect(200);
    expect(far.body.data[0]).toMatchObject({ valid: false, reason: 'Over 20000 km' });
    expect(far.body.data[1]).toMatchObject({ valid: true });
  });
});

describe('a battery pack replaced under warranty, and claimed from its supplier', () => {
  it('takes the scooter in for the customer it was sold to; it is under repair while in', async () => {
    const tech = await w.as('technician');
    const res = await tech.post('/api/service/jobs').send({ serial: 'SC-1', complaint: 'Battery does not hold charge', odometer_km: 8000 }).expect(201);
    id.job1 = res.body.data.id;
    expect(res.body.data).toMatchObject({ party_id: id.customer, status: 'open' });
    expect(res.body.data.job_no).toMatch(/^JC\/\d\d-\d\d\/00001$/);
    expect((await unit('SC-1')).status).toBe('under_repair');
    expect((await unit('BP-OLD')).status).toBe('under_repair');
    const again = await tech.post('/api/service/jobs').send({ serial: 'SC-1', complaint: 'Again' }).expect(409);
    expect(again.body.error.message).toMatch(/already in the workshop on JC/);
  });

  it('makes the pack and the labour free, and only the service manager can change that', async () => {
    const tech = await w.as('technician');
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'diagnosed' }).expect(400);
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'diagnosed', diagnosis: 'Cell imbalance in the pack' }).expect(200);
    const old = await unit('BP-OLD');
    await tech.post(`/api/service/jobs/${id.job1}/faults`).send({ fault_code_id: id.fault, unit_id: old.id }).expect(201);
    const pack = await tech.post(`/api/service/jobs/${id.job1}/lines`).send({ kind: 'part', item_id: id.pack, qty: 1 }).expect(201);
    expect(pack.body.data.is_warranty).toBe(true);
    id.packLine = pack.body.data.id;
    await tech.post(`/api/service/jobs/${id.job1}/lines`).send({ kind: 'labour', item_id: id.labour, qty: 2 }).expect(201);
    await tech.post(`/api/service/jobs/${id.job1}/lines`).send({ kind: 'labour', item_id: id.labour, qty: 1, is_warranty: false }).expect(403);
    const doc = (await tech.get(`/api/service/jobs/${id.job1}`).expect(200)).body.data;
    expect(doc.chargeable.grand_total).toBe('0.00');
    // Free at what they would have cost: ₹23,600 + 2 x ₹1,180.
    expect(doc.free.grand_total).toBe('25960.00');
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'estimate_sent' }).expect(400);
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'approved' }).expect(200);
  });

  it('fits the spare pack from the workshop shelf by serial, its cost to warranty expense', async () => {
    const tech = await w.as('technician');
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'ready' }).expect(409);
    await tech.post(`/api/service/jobs/${id.job1}/lines/${id.packLine}/issue`).send({ qty: 1, serials: ['BP-NEW'] }).expect(200);
    expect(await balance('warranty_expense')).toBe(15000);
    expect(await atBay(id.pack)).toBe(0);
    expect(await unit('BP-NEW')).toMatchObject({ parent: 'SC-1', status: 'sold' });
    // Tech never sees what the part cost.
    const doc = (await tech.get(`/api/service/jobs/${id.job1}`).expect(200)).body.data;
    expect(doc.lines[0].issued_value).toBeUndefined();
    await tech.post(`/api/service/jobs/${id.job1}/move`).send({ to: 'ready' }).expect(200);
    const done = await tech.post(`/api/service/jobs/${id.job1}/deliver`).send({}).expect(200);
    expect(done.body.data.invoice).toBeNull();
    expect((await unit('SC-1')).status).toBe('sold');
  });

  it('claims the failed pack from its supplier; the credit comes off warranty expense and what we owe', async () => {
    const old = await unit('BP-OLD');
    await (await w.as('technician')).post('/api/service/claims').send({ job_card_id: id.job1, unit_id: old.id, supplier_id: id.supplier }).expect(403);
    const manager = await w.as('service_manager');
    const claim = await manager.post('/api/service/claims').send({ job_card_id: id.job1, unit_id: old.id, supplier_id: id.supplier, amount: 15000 }).expect(201);
    expect(claim.body.data.status).toBe('draft');
    await manager.post(`/api/service/claims/${claim.body.data.id}/move`).send({ to: 'credited' }).expect(409);
    await manager.post(`/api/service/claims/${claim.body.data.id}/move`).send({ to: 'sent' }).expect(200);
    await manager.post(`/api/service/claims/${claim.body.data.id}/move`).send({ to: 'accepted' }).expect(200);
    await manager.post(`/api/service/claims/${claim.body.data.id}/move`).send({ to: 'credited' }).expect(400);
    await manager.post(`/api/service/claims/${claim.body.data.id}/move`).send({ to: 'credited', credit_note_ref: 'CP/CN/77' }).expect(200);
    expect(await balance('warranty_expense')).toBe(0);
    expect(await balance('creditors', id.supplier)).toBe(15000);
  });
});

describe('work out of warranty, approved from the estimate link and billed at hand-back', () => {
  it('prices the lines from the price list and sends the estimate as a link', async () => {
    const tech = await w.as('technician');
    id.job2 = (await tech.post('/api/service/jobs').send({ serial: 'SC-2', complaint: 'Brakes squeal' }).expect(201)).body.data.id;
    await tech.post(`/api/service/jobs/${id.job2}/move`).send({ to: 'diagnosed', diagnosis: 'Pads worn' }).expect(200);
    id.padLine = (await tech.post(`/api/service/jobs/${id.job2}/lines`).send({ kind: 'part', item_id: id.pad, qty: 2 }).expect(201)).body.data.id;
    await tech.post(`/api/service/jobs/${id.job2}/lines`).send({ kind: 'labour', item_id: id.labour, qty: 1 }).expect(201);
    const doc = (await tech.get(`/api/service/jobs/${id.job2}`).expect(200)).body.data;
    // 2 x ₹590 + ₹1,180 = ₹2,360 with GST: ₹2,000 + ₹360.
    expect(doc.chargeable).toMatchObject({ taxable_total: '2000.00', grand_total: '2360.00' });
    const sent = await tech.post(`/api/service/jobs/${id.job2}/move`).send({ to: 'estimate_sent' }).expect(200);
    id.token = sent.body.data.estimate_url.split('/e/')[1];
  });

  it('lets the customer see and approve the estimate without signing in', async () => {
    const seen = await request(w.app).get(`/api/public/estimates/${id.token}`).expect(200);
    expect(seen.body.data).toMatchObject({ job_no: expect.stringMatching(/^JC\//), status: 'estimate_sent' });
    expect(seen.body.data.chargeable.grand_total).toBe('2360.00');
    expect(JSON.stringify(seen.body.data)).not.toMatch(/issued_value|purchase_cost/);
    await request(w.app).post('/api/public/estimates/not-a-token/approve').send({}).expect(404);
    await request(w.app).post(`/api/public/estimates/${id.token}/approve`).send({}).expect(200);
    await request(w.app).post(`/api/public/estimates/${id.token}/approve`).send({}).expect(409);
    const doc = (await (await w.as('technician')).get(`/api/service/jobs/${id.job2}`).expect(200)).body.data;
    expect(doc).toMatchObject({ status: 'approved', approved_via: 'link' });
  });

  it('fits the pads (to cost of goods sold) and bills the work through the usual invoice', async () => {
    const tech = await w.as('technician');
    const cogs = await balance('cogs');
    await tech.post(`/api/service/jobs/${id.job2}/lines/${id.padLine}/issue`).send({ qty: 2 }).expect(200);
    expect(await balance('cogs')).toBe(cogs + 400);
    await tech.post(`/api/service/jobs/${id.job2}/move`).send({ to: 'ready' }).expect(200);
    const done = await tech.post(`/api/service/jobs/${id.job2}/deliver`).send({}).expect(200);
    expect(done.body.data.invoice).toMatchObject({ channel: 'service', grand_total: '2360.00', taxable_total: '2000.00' });
    // The pads left stock once, when fitted: not again on the bill.
    expect(await atBay(id.pad)).toBe(8);
    expect(await balance('cogs')).toBe(cogs + 400);
    await expectBooksHealthy(w);
  });
});

describe('cancelling, and the reports', () => {
  it('cancels a job with nothing fitted and gives the unit back', async () => {
    const tech = await w.as('technician');
    const job = (await tech.post('/api/service/jobs').send({ serial: 'SC-1', complaint: 'Horn not working' }).expect(201)).body.data;
    await tech.post(`/api/service/jobs/${job.id}/move`).send({ to: 'cancelled' }).expect(400);
    await tech.post(`/api/service/jobs/${job.id}/move`).send({ to: 'cancelled', reason: 'Fuse replaced at the counter' }).expect(200);
    expect((await unit('SC-1')).status).toBe('sold');
  });

  it('shows the history of a serial, comebacks within 30 days, jobs per technician and what fails', async () => {
    const tech = await w.as('technician');
    // SC-1 back again a few days after its pack was replaced: a comeback.
    await tech.post('/api/service/jobs').send({ serial: 'SC-1', complaint: 'Range dropped again' }).expect(201);
    const history = (await tech.get('/api/service/reports/history?serial=BP-NEW').expect(200)).body.data;
    expect(history.map((h: any) => h.serial_no)).toEqual(['SC-1', 'SC-1', 'SC-1']);
    const comebacks = (await tech.get('/api/service/reports/comebacks').expect(200)).body.data;
    // The brief's rule: any new job card on the same unit within 30 days, so the cancelled one counts too.
    expect(comebacks.map((c: any) => c.complaint).sort()).toEqual(['Horn not working', 'Range dropped again']);
    const techs = (await tech.get('/api/service/reports/technicians').expect(200)).body.data;
    expect(techs.reduce((n: number, t: any) => n + t.jobs, 0)).toBe(2);
    const failures = (await tech.get('/api/service/reports/failures').expect(200)).body.data;
    expect(failures.by_component).toEqual([expect.objectContaining({ code: 'BMS-02', times: 1 })]);
    expect(failures.by_batch).toEqual([expect.objectContaining({ batch_no: 'CELLS-9', supplier: 'Cell Power Ltd', faults: 1 })]);
    expect(failures.by_model).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'Scooter S1' })]));
    await (await w.as('sales')).get('/api/service/jobs').expect(403);
  });
});
