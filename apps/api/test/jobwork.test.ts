import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, istDate } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, onHand, openingStock, setup, type Agent, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let away: string; // the "With job workers" place in stock
const id: Record<string, string> = {};
const today = istDate();

/** Balance of a system account: positive = debit. */
const balance = async (key: string) =>
  Number((await rows<{ b: string }>(w.db, sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.system_key = ${key}`))[0]!.b);
/** What an item stands at in the books: quantity and value over every location. */
const worth = async (itemId: string) => {
  const [r] = await rows<{ qty: string; value: string }>(w.db, sql`select coalesce(sum(qty), 0)::text as qty, coalesce(sum(value), 0)::text as value from stock_movements where item_id = ${itemId}`);
  return [Number(r!.qty), Number(r!.value)];
};
const challan = async (jobId: string) => (await (await w.as('stores')).get(`/api/jobwork/${jobId}`).expect(200)).body.data;
// Both are sent as the stores user. They hand back the request itself, so each test can say what answer it expects.
let storesUser: Agent;
const send = (body: Record<string, unknown>) =>
  storesUser.post('/api/jobwork').send({ job_worker_id: id.coater, from_location_id: m.stores, challan_date: today, process: 'Powder coating', ...body });
const receive = (jobId: string, body: Record<string, unknown>) =>
  storesUser.post(`/api/jobwork/${jobId}/receipts`).send({ received_on: today, to_location_id: m.stores, ...body });
const lineOf = (job: any, itemId: string) => job.lines.find((l: any) => l.item_id === itemId);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  storesUser = await w.as('stores');
  away = (await rows<{ id: string }>(w.db, sql`select id from locations where type = 'job_work'`))[0]!.id;
  const admin = await w.as('admin');
  const item = async (body: Record<string, unknown>) => (await admin.post('/api/items').send({ gst_rate: 18, ...body }).expect(201)).body.data.id as string;
  id.board = await item({ sku: 'BRD-1', name: 'Board', item_type: 'finished_good', hsn_sac: '950699', retail_price: 5900, purchase_cost: 2500 });
  id.frame = await item({ sku: 'FRM-RAW', name: 'Chassis frame (raw)', item_type: 'raw_material', hsn_sac: '871499', purchase_cost: 1000 });
  id.sheet = await item({ sku: 'SHT-2', name: 'Steel sheet', item_type: 'raw_material', hsn_sac: '720851', unit: 'Sheet', purchase_cost: 400 });
  id.coated = await item({ sku: 'FRM-PC', name: 'Chassis frame (coated)', item_type: 'spare_part', hsn_sac: '871499' });
  id.charges = await item({ sku: 'JOBWORK', name: 'Job work charges', item_type: 'service', hsn_sac: '9988' });
  await openingStock(w, m.stores, [
    { item_id: id.board!, qty_change: '20', unit_cost: '2500.00' }, { item_id: id.frame!, qty_change: '100', unit_cost: '1000.00' },
    { item_id: id.sheet!, qty_change: '50', unit_cost: '400.00' },
  ]);
  const party = async (body: Record<string, unknown>) => (await admin.post('/api/parties').send(body).expect(201)).body.data.id as string;
  id.coater = await party({ party_type: 'supplier', name: 'Sharma Coaters', phone: '9700000011', gstin: gstin('27', 'ABCPS1234K') });
  id.welder = await party({ party_type: 'supplier', name: 'Pune Weld Works', phone: '9700000012' });
  id.dealer = await party({ party_type: 'dealer', name: 'Bangalore Boards', phone: '9700000013' });
});
afterAll(() => w.close());

describe('sending material out for job work', () => {
  it('moves it off our shelves without changing what it is worth, and refuses what cannot be sent', async () => {
    await send({ job_worker_id: id.dealer, lines: [{ item_id: id.board, qty: 1 }] }).expect(400); // not a supplier
    await send({ lines: [{ item_id: id.board, qty: 21 }] }).expect(409); // only 20 on the shelf
    await send({ lines: [{ item_id: id.charges, qty: 1 }] }).expect(400); // a service has no stock
    await send({ lines: [{ item_id: id.board, qty: 1 }, { item_id: id.board, qty: 2 }] }).expect(400); // listed twice
    await send({ challan_date: addDays(today, 1), lines: [{ item_id: id.board, qty: 1 }] }).expect(400);
    await send({ expected_back_on: addDays(today, -1), lines: [{ item_id: id.board, qty: 1 }] }).expect(400);
    await send({ from_location_id: away, lines: [{ item_id: id.board, qty: 1 }] }).expect(400);
    await (await w.as('sales')).post('/api/jobwork').send({}).expect(403);
    await (await w.as('accounts')).post('/api/jobwork').send({ job_worker_id: id.coater, from_location_id: m.stores, process: 'x', lines: [{ item_id: id.board, qty: 1 }] }).expect(403);

    // Ten boards go to be painted.
    const res = await send({ process: 'Graffiti paint', expected_back_on: addDays(today, 7), transport: 'MH12 AB 1234', lines: [{ item_id: id.board, qty: 10 }] }).expect(201);
    id.paint = res.body.data.id;
    expect(res.body.data.challan_no).toMatch(/^JW\/\d\d-\d\d\/00001$/);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(10);
    expect(await onHand(w.db, id.board!, away)).toBe(10);
    expect(await worth(id.board!)).toEqual([20, 50000]); // still ours, still worth the same
    expect(await balance('stock')).toBe(50000 + 100000 + 20000);

    // On the stock screen they are no longer counted as available.
    const stock = (await (await w.as('stores')).get('/api/stock/on-hand?q=BRD-1').expect(200)).body.data[0];
    expect(stock).toMatchObject({ stores_qty: '10.000', job_work_qty: '10.000', available_qty: '10.000' });
    expect((await (await w.as('stores')).get('/api/items?q=BRD-1').expect(200)).body.data[0].on_hand).toBe('10.000');

    const job = await challan(id.paint!);
    expect(job).toMatchObject({ status: 'open', job_worker_name: 'Sharma Coaters', from_location: 'Stores', process: 'Graffiti paint', out_value: '25000.00', due_back_by: addMonths(today, 12), days_out: 0 });
    expect(lineOf(job, id.board!)).toMatchObject({ qty: '10.000', unit_cost: '2500.00', value: '25000.00', returned: '0.000', pending: '10.000' });
  });

  it('lets nothing but a challan touch stock that is with a job worker', async () => {
    const stores = await w.as('stores');
    const move = (from: string, to: string) => stores.post('/api/stock/transfers').send({ from_location_id: from, to_location_id: to, reason: 'Bringing it back', lines: [{ item_id: id.board, qty: 1 }] });
    expect((await move(away, m.stores).expect(400)).body.error.message).toMatch(/job work challan/);
    await move(m.stores, away).expect(400);
    await stores.post('/api/stock/adjustments').send({ kind: 'adjustment', location_id: away, reason: 'One short', lines: [{ item_id: id.board, qty_change: '-1' }] }).expect(400);
    // Nor can it be sold from there.
    const bill = await (await w.as('store')).post('/api/sales/quick-bill').send({ location_id: away, lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'cash', amount: 5900 }] });
    expect(bill.status).toBe(400);
    expect(bill.body.error.message).toMatch(/job work challan/);
    expect(await onHand(w.db, id.board!, away)).toBe(10);
  });
});

describe('the same goods coming back', () => {
  it('puts them back on the shelf, with the job charge added to what they cost', async () => {
    const board = lineOf(await challan(id.paint!), id.board!).id;
    await receive(id.paint!, { lines: [{ line_id: board, returned: 11 }] }).expect(409); // more than went
    await receive(id.paint!, { lines: [] }).expect(400);
    await receive(id.paint!, { received_on: addDays(today, -1), lines: [{ line_id: board, returned: 1 }] }).expect(400); // before it was sent
    await receive(id.paint!, { to_location_id: away, lines: [{ line_id: board, returned: 1 }] }).expect(400);
    await receive(id.paint!, { charge: 500, lines: [{ line_id: board, lost: 1 }] }).expect(400); // a charge on goods that did not come back

    // Six come back painted; the painter charges 200 a board.
    const res = await receive(id.paint!, { worker_challan_no: 'SC/88', charge: 1200, lines: [{ line_id: board, returned: 6 }] }).expect(201);
    id.paintBack = res.body.data.id;
    expect(res.body.data).toMatchObject({ charge: '1200.00', closed: false });
    expect(res.body.data.receipt_no).toMatch(/^JWR\/\d\d-\d\d\/00001$/);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(16);
    expect(await onHand(w.db, id.board!, away)).toBe(4);
    // 20 boards now stand at 50,000 + 1,200 = 51,200, or 2,560 each.
    expect(await worth(id.board!)).toEqual([20, 51200]);
    expect(await balance('job_work_accrued')).toBe(-1200); // owed to the painter until the bill comes
    expect(await balance('stock')).toBe(170000 + 1200);

    const list = (await (await w.as('accounts')).get('/api/jobwork').expect(200)).body;
    expect(list.totals).toMatchObject({ open_challans: 1, value_out: '10000.00', late: 0 }); // 4 boards at the 2,500 they went out at
    expect(list.data[0]).toMatchObject({ challan_no: (await challan(id.paint!)).challan_no, status: 'open', still_out: '4 Nos Board', sent_value: '25000.00', late: false });
    await (await w.as('sales')).get('/api/jobwork').expect(403);
  });

  it('writes off what is lost, and closes the challan when every unit is accounted for', async () => {
    const board = lineOf(await challan(id.paint!), id.board!).id;
    // Three more come back; the fourth was dropped and is not coming.
    const res = await receive(id.paint!, { lines: [{ line_id: board, returned: 3, lost: 1 }] }).expect(201);
    expect(res.body.data.closed).toBe(true);
    expect(await onHand(w.db, id.board!, m.stores)).toBe(19);
    expect(await onHand(w.db, id.board!, away)).toBe(0);
    expect(await worth(id.board!)).toEqual([19, 48640]); // one board of 2,560 gone
    expect(await balance('stock_adjustment')).toBe(2560);

    const job = await challan(id.paint!);
    expect(job.status).toBe('closed');
    expect(lineOf(job, id.board!)).toMatchObject({ returned: '9.000', lost: '1.000', consumed: '0.000', pending: '0.000' });
    expect(job.receipts.map((r: any) => r.lines.map((l: any) => [l.kind, l.qty, l.value]))).toEqual([
      [['returned', '6.000', '16200.00']], // 15,000 of board and 1,200 of paint
      [['lost', '1.000', '2560.00'], ['returned', '3.000', '7680.00']],
    ]);
    await receive(id.paint!, { lines: [{ line_id: board, returned: 1 }] }).expect(409); // nothing left to account for
    await expectBooksHealthy(w);
  });

  it('settles the charge when the job worker’s bill is booked against the challan, and expenses only the rest', async () => {
    const accounts = await w.as('accounts');
    const bill = (body: Record<string, unknown>) => accounts.post('/api/purchasing/bills').send({ supplier_id: id.coater, bill_date: today, ...body });
    await bill({ supplier_id: id.welder, supplier_invoice_no: 'PW/1', job_work_id: id.paint, lines: [{ item_id: id.charges, qty: 1, rate: 100 }] }).expect(400); // another job worker's challan

    // The painter bills 1,500: the 1,200 already in the cost of the boards, and 300 for carrying them.
    const res = await bill({ supplier_invoice_no: 'SC/INV/31', job_work_id: id.paint, lines: [{ item_id: id.charges, qty: 1, rate: 1500 }] }).expect(201);
    expect(res.body.data).toMatchObject({ taxable_total: '1500.00', cgst_total: '135.00', sgst_total: '135.00', grand_total: '1770.00', job_work_cleared: '1200.00' });
    expect(await balance('job_work_accrued')).toBe(0);
    expect(await balance('purchases')).toBe(300); // only the part not already in stock
    expect(await balance('creditors')).toBe(-1770);
    expect((await challan(id.paint!)).charges).toEqual({ added_to_cost: '1200.00', billed: '1200.00', still_to_bill: '0.00' });
    expect((await challan(id.paint!)).bills.map((b: any) => [b.supplier_invoice_no, b.job_work_cleared])).toEqual([['SC/INV/31', '1200.00']]);
    const detail = (await accounts.get(`/api/purchasing/bills/${res.body.data.id}`).expect(200)).body.data;
    expect(detail.job_work_challan_no).toMatch(/^JW\//);

    // The receipt that added the charge can no longer be undone on its own.
    const undo = await (await w.as('stores')).post(`/api/jobwork/receipts/${id.paintBack}/cancel`).send({ reason: 'Wrong count' }).expect(409);
    expect(undo.body.error.message).toMatch(/bill has already been booked/);
    await expectBooksHealthy(w);
  });
});

describe('material made into something else', () => {
  it('values what was made at what was used to make it, plus the charge', async () => {
    const res = await send({ process: 'Powder coating and gusset welding', lines: [{ item_id: id.frame, qty: 40 }, { item_id: id.sheet, qty: 10 }] }).expect(201);
    id.coat = res.body.data.id;
    expect(await worth(id.frame!)).toEqual([100, 100000]);
    const job = await challan(id.coat!);
    expect(job.out_value).toBe('44000.00'); // 40 frames at 1,000 and 10 sheets at 400
    const frame = lineOf(job, id.frame!).id;
    const sheet = lineOf(job, id.sheet!).id;
    id.frameLine = frame; id.sheetLine = sheet;

    await receive(id.coat!, { produced: { item_id: id.coated, qty: 20 }, lines: [] }).expect(400); // made from what?
    await receive(id.coat!, { lines: [{ line_id: frame, consumed: 20 }] }).expect(400); // made into what?
    await receive(id.coat!, { produced: { item_id: id.charges, qty: 20 }, lines: [{ line_id: frame, consumed: 20 }] }).expect(400); // a service is not stock
    await receive(id.coat!, { produced: { qty: 20 }, lines: [{ line_id: frame, consumed: 20 }] }).expect(400);

    // 20 coated frames come back, made from 20 raw frames and 5 sheets; the coater charges 3,000.
    const first = await receive(id.coat!, { charge: 3000, produced: { item_id: id.coated, qty: 20 }, lines: [{ line_id: frame, consumed: 20 }, { line_id: sheet, consumed: 5 }] }).expect(201);
    id.coatBack1 = first.body.data.id;
    // 20,000 of frames + 2,000 of sheet + 3,000 charge = 25,000, or 1,250 a frame.
    expect(await worth(id.coated!)).toEqual([20, 25000]);
    expect(await onHand(w.db, id.coated!, m.stores)).toBe(20);
    expect(await worth(id.frame!)).toEqual([80, 80000]);
    expect(await worth(id.sheet!)).toEqual([45, 18000]);
    expect(await balance('job_work_accrued')).toBe(-3000);
    const stock = (await (await w.as('stores')).get('/api/stock/on-hand?q=FRM-PC').expect(200)).body.data[0];
    expect(Number(stock.avg_cost)).toBe(1250);
    await expectBooksHealthy(w);
  });

  it('takes a frame spoiled in the work into the cost of the good ones, with no paise left over', async () => {
    // The other 20 frames and 4 sheets make only 19 good frames; one sheet comes back unused.
    const res = await receive(id.coat!, {
      produced: { item_id: id.coated, qty: 19 }, lines: [{ line_id: id.frameLine, consumed: 20 }, { line_id: id.sheetLine, consumed: 4, returned: 1 }],
    }).expect(201);
    id.coatBack2 = res.body.data.id;
    expect(res.body.data.closed).toBe(true);
    // 20,000 + 1,600 = 21,600 over 19 frames is 1,136.84 each, but the stock is worth exactly 21,600.
    expect(await worth(id.coated!)).toEqual([39, 46600]);
    expect(await worth(id.frame!)).toEqual([60, 60000]);
    expect(await worth(id.sheet!)).toEqual([41, 16400]);
    expect(await onHand(w.db, id.sheet!, m.stores)).toBe(41);
    expect(await onHand(w.db, id.frame!, away)).toBe(0);
    const job = await challan(id.coat!);
    expect(job.status).toBe('closed');
    expect(lineOf(job, id.sheet!)).toMatchObject({ consumed: '9.000', returned: '1.000', lost: '0.000', pending: '0.000' });
    expect(job.receipts[1].lines.map((l: any) => [l.kind, l.item, l.qty, l.value])).toEqual([
      ['consumed', 'Chassis frame (raw)', '20.000', '20000.00'], ['consumed', 'Steel sheet', '4.000', '1600.00'],
      ['produced', 'Chassis frame (coated)', '19.000', '21600.00'], ['returned', 'Steel sheet', '1.000', '400.00'],
    ]);
    await expectBooksHealthy(w);
  });

  it('undoes a receipt entered wrongly and reopens the challan', async () => {
    const stores = await w.as('stores');
    await (await w.as('accounts')).post(`/api/jobwork/receipts/${id.coatBack2}/cancel`).send({ reason: 'x' }).expect(403);
    await stores.post(`/api/jobwork/receipts/${id.coatBack2}/cancel`).send({ reason: 'Counted 19, there were 20' }).expect(200);
    await stores.post(`/api/jobwork/receipts/${id.coatBack2}/cancel`).send({ reason: 'again' }).expect(409);
    expect(await worth(id.coated!)).toEqual([20, 25000]);
    expect(await worth(id.frame!)).toEqual([80, 80000]);
    expect(await worth(id.sheet!)).toEqual([45, 18000]);
    expect(await onHand(w.db, id.frame!, away)).toBe(20);
    expect(await onHand(w.db, id.sheet!, away)).toBe(5);
    expect(await onHand(w.db, id.sheet!, m.stores)).toBe(40);
    const job = await challan(id.coat!);
    expect(job.status).toBe('open');
    expect(lineOf(job, id.frame!)).toMatchObject({ consumed: '20.000', pending: '20.000' });
    expect(job.receipts.map((r: any) => r.status)).toEqual(['posted', 'cancelled']);

    // Entered again, correctly this time: all 20 came out good.
    await receive(id.coat!, { produced: { item_id: id.coated, qty: 20 }, lines: [{ line_id: id.frameLine, consumed: 20 }, { line_id: id.sheetLine, consumed: 4, returned: 1 }] }).expect(201);
    expect(await worth(id.coated!)).toEqual([40, 46600]);
    expect((await challan(id.coat!)).status).toBe('closed');
    await expectBooksHealthy(w);
  });

  it('leaves the rest of a charge showing when the bill is for less', async () => {
    const accounts = await w.as('accounts');
    const res = await accounts.post('/api/purchasing/bills').send({
      supplier_id: id.coater, bill_date: today, supplier_invoice_no: 'SC/INV/40', job_work_id: id.coat, lines: [{ item_id: id.charges, qty: 1, rate: 2500 }],
    }).expect(201);
    expect(res.body.data.job_work_cleared).toBe('2500.00');
    expect(await balance('purchases')).toBe(300); // nothing more expensed
    expect(await balance('job_work_accrued')).toBe(-500);
    expect((await challan(id.coat!)).charges).toEqual({ added_to_cost: '3000.00', billed: '2500.00', still_to_bill: '500.00' });
    const open = (await accounts.get(`/api/jobwork/for-billing?supplier_id=${id.coater}`).expect(200)).body.data;
    expect(open.map((c: any) => [c.process, c.still_to_bill])).toEqual(expect.arrayContaining([['Powder coating and gusset welding', '500.00'], ['Graffiti paint', '0.00']]));
  });
});

describe('putting mistakes right', () => {
  it('cancels a challan nothing has come back on, and puts the material back', async () => {
    const res = await send({ job_worker_id: id.welder, process: 'Welding', lines: [{ item_id: id.sheet, qty: 5 }] }).expect(201);
    expect(await onHand(w.db, id.sheet!, m.stores)).toBe(36);
    const stores = await w.as('stores');
    await stores.post(`/api/jobwork/${res.body.data.id}/cancel`).send({ reason: 'Sent to the wrong worker' }).expect(200);
    await stores.post(`/api/jobwork/${res.body.data.id}/cancel`).send({ reason: 'again' }).expect(409);
    expect(await onHand(w.db, id.sheet!, m.stores)).toBe(41);
    expect(await onHand(w.db, id.sheet!, away)).toBe(0);
    expect(await worth(id.sheet!)).toEqual([41, 16400]);
    expect((await challan(res.body.data.id)).status).toBe('cancelled');
    await receive(res.body.data.id, { lines: [] }).expect(409);
  });

  it('will not cancel a challan, or undo a receipt, once the goods have moved on', async () => {
    const stores = await w.as('stores');
    const res = await send({ job_worker_id: id.welder, process: 'Welding', expected_back_on: today, lines: [{ item_id: id.sheet, qty: 2 }] }).expect(201);
    const job = await challan(res.body.data.id);
    const back = await receive(job.id, { to_location_id: m.showroom, lines: [{ line_id: job.lines[0].id, returned: 2 }] }).expect(201);
    await stores.post(`/api/jobwork/${job.id}/cancel`).send({ reason: 'x' }).expect(409); // something has come back on it
    // The two sheets are moved on from the showroom, so the receipt can no longer simply be reversed.
    await stores.post('/api/stock/transfers').send({ from_location_id: m.showroom, to_location_id: m.stores, reason: 'To the rack', lines: [{ item_id: id.sheet, qty: 2 }] }).expect(201);
    const undo = await stores.post(`/api/jobwork/receipts/${back.body.data.id}/cancel`).send({ reason: 'Wrong challan' }).expect(409);
    expect(undo.body.error.message).toMatch(/Only 0\.000 of Steel sheet is left in Showroom/);
    expect((await challan(job.id)).status).toBe('closed');
  });
});

describe('the registers for the GST job work return', () => {
  it('lists what was sent out and what came back in a period', async () => {
    const accounts = await w.as('accounts');
    const sent = (await accounts.get(`/api/jobwork/register?kind=sent&from=${today}&to=${today}`).expect(200)).body.data;
    // Four lines on three challans; the cancelled one is not there.
    expect(sent.map((r: any) => [r.job_worker, r.description, Number(r.qty), r.taxable_value])).toEqual([
      ['Sharma Coaters', 'Board', 10, '25000.00'], ['Sharma Coaters', 'Chassis frame (raw)', 40, '40000.00'],
      ['Sharma Coaters', 'Steel sheet', 10, '4000.00'], ['Pune Weld Works', 'Steel sheet', 2, '800.00'],
    ]);
    expect(sent[0]).toMatchObject({ job_worker_gstin: gstin('27', 'ABCPS1234K'), job_worker_state: 'Maharashtra', hsn_sac: '950699', unit: 'Nos', nature_of_job_work: 'Graffiti paint' });

    const back = (await accounts.get(`/api/jobwork/register?kind=received&from=${today}&to=${today}`).expect(200)).body.data;
    const count = (what: string) => back.filter((r: any) => r.what === what).length;
    expect([count('Received back'), count('Received back, made from the material'), count('Used in what was made'), count('Lost or wasted')]).toEqual([4, 2, 4, 1]); // the receipt that was undone is not counted
    expect(back.find((r: any) => r.what === 'Lost or wasted')).toMatchObject({ description: 'Board', job_worker_challan_no: null });
    expect(back[0]).toMatchObject({ job_worker_challan_no: 'SC/88', original_challan_date: today });
    // Nothing was sent yesterday.
    expect((await accounts.get(`/api/jobwork/register?kind=sent&from=${addDays(today, -2)}&to=${addDays(today, -1)}`).expect(200)).body.data).toEqual([]);
    // Both come out as files.
    const file = await accounts.get(`/api/jobwork/register?kind=sent&from=${today}&to=${today}&format=csv`).expect(200);
    expect(file.text).toContain('challan_no');
    expect(file.text).toContain('Sharma Coaters');
  });

  it('leaves the stock ledger and the books in step', async () => {
    const health = await expectBooksHealthy(w);
    expect(health.stock_matches_gl).toBe(true);
    // Everything that went out is back or accounted for: nothing is with a job worker.
    const list = (await (await w.as('owner')).get('/api/jobwork').expect(200)).body;
    expect(list.totals).toMatchObject({ open_challans: 0, value_out: '0.00' });
    expect(list.data.map((c: any) => c.status).sort()).toEqual(['cancelled', 'closed', 'closed', 'closed']);
  });
});
