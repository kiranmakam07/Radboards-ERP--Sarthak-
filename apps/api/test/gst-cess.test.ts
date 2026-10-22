import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLine, computeTotals } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { expectBooksHealthy, gstin, masters, openingStock, setup, type World } from './helpers';

/**
 * P0 #4: an item at 40% GST could not even be saved (the rate check allowed 0/5/12/18/28 only),
 * and there was no cess anywhere. Now the rates are 0, 0.25, 3, 5, 12, 18, 28 and 40, an item can
 * carry a cess %, and cess runs through the invoice, the credit note, the books and the returns.
 * Every figure below is worked out by hand.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const MONTH = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);

const balance = async (key: string) => {
  const [r] = await rows<{ b: string }>(w.db, sql`
    select coalesce(sum(l.credit) - sum(l.debit), 0)::numeric(14,2)::text as b
      from journal_lines l join accounts a on a.id = l.account_id where a.system_key = ${key}`);
  return r!.b;
};

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  // 40% GST, no cess: dealer ₹10,000 before GST.
  id.premium = (await admin.post('/api/items').send({
    sku: 'PRM-40', name: 'Premium Board', item_type: 'finished_good', hsn_sac: '870380', gst_rate: 40, dealer_price: 10000, purchase_cost: 6000,
  }).expect(201)).body.data.id;
  // 28% GST + 12% cess: dealer ₹1,000 before tax; retail ₹1,400 with GST and cess (1,000 + 280 + 120).
  id.cessed = (await admin.post('/api/items').send({
    sku: 'CSS-1', name: 'Cessed Goods', item_type: 'finished_good', hsn_sac: '220299', gst_rate: 28, cess_rate: '12', dealer_price: 1000, retail_price: 1400, purchase_cost: 600,
  }).expect(201)).body.data.id;
  await openingStock(w, m.stores, [{ item_id: id.premium!, qty_change: '10', unit_cost: '6000' }, { item_id: id.cessed!, qty_change: '20', unit_cost: '600' }]);
  await openingStock(w, m.showroom, [{ item_id: id.cessed!, qty_change: '5', unit_cost: '600' }]);
  id.local = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Pune Motors', phone: '9700000011', gstin: gstin('27', 'LOCAL1234A') }).expect(201)).body.data.id;
  id.away = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Bengaluru Motors', phone: '9700000012', gstin: gstin('29', 'AWAYS1234B') }).expect(201)).body.data.id;
});
afterAll(() => w.close());

const sell = async (partyId: string, lines: { item_id: string; qty: number }[]) => {
  const sales = await w.as('sales');
  const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: partyId, lines }).expect(201)).body.data;
  await sales.post(`/api/sales/orders/${order.id}/confirm`).send({}).expect(200);
  await (await w.as('stores')).post(`/api/sales/orders/${order.id}/deliver`).send({}).expect(201);
  return (await sales.post(`/api/sales/orders/${order.id}/invoice`).send({}).expect(201)).body.data;
};

describe('the rates', () => {
  it('accepts 0, 0.25, 3, 5, 12, 18, 28 and 40, and nothing else', async () => {
    const admin = await w.as('admin');
    for (const [i, rate] of [0.25, 3, 40].entries()) {
      const made = await admin.post('/api/items').send({ sku: `RATE-${i}`, name: `Rate ${rate}`, item_type: 'spare_part', hsn_sac: '950699', gst_rate: rate });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
    }
    const bad = await admin.post('/api/items').send({ sku: 'RATE-X', name: 'Ten', item_type: 'spare_part', hsn_sac: '950699', gst_rate: 10 }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/0, 0\.25, 3, 5, 12, 18, 28, 40/);
    await admin.post('/api/items').send({ sku: 'RATE-Y', name: 'Neg cess', item_type: 'spare_part', hsn_sac: '950699', gst_rate: 18, cess_rate: '-1' }).expect(400);
  });

  it('works cess out on top of GST, and backs both out of a price that includes them', () => {
    // ₹3,000 at 28% + 12%: CGST 420, SGST 420, cess 360 = ₹4,200.
    expect(computeLine({ qty: 3, rate: 1000, gstRate: 28, cessRate: 12 }, false)).toMatchObject({ cgst: expect.anything(), lineTotal: expect.anything() });
    const local = computeLine({ qty: 3, rate: 1000, gstRate: 28, cessRate: 12 }, false);
    expect([local.taxableValue, local.cgst, local.sgst, local.cess, local.lineTotal].map(String)).toEqual(['3000', '420', '420', '360', '4200']);
    // ₹1,400 including 28% + 12%: taxable 1,000.
    const inclusive = computeLine({ qty: 1, rate: 1400, gstRate: 28, cessRate: 12 }, true, true);
    expect([inclusive.taxableValue, inclusive.igst, inclusive.cess, inclusive.lineTotal].map(String)).toEqual(['1000', '280', '120', '1400']);
    expect(String(computeTotals([local, inclusive]).cessTotal)).toBe('480');
  });
});

describe('invoices', () => {
  it('bills an item at 40% within the state: CGST 20% + SGST 20%', async () => {
    // 2 x ₹10,000 = ₹20,000; CGST 4,000; SGST 4,000; total ₹28,000.
    const inv = await sell(id.local!, [{ item_id: id.premium!, qty: 2 }]);
    expect(inv).toMatchObject({ taxable_total: '20000.00', cgst_total: '4000.00', sgst_total: '4000.00', igst_total: '0.00', cess_total: '0.00', grand_total: '28000.00' });
    id.inv40 = inv.id;
  });

  it('bills cess within the state and to another state, and keeps it on each line', async () => {
    // Within: 3 x ₹1,000 = 3,000; CGST 420 + SGST 420 + cess 360 = ₹4,200.
    const local = await sell(id.local!, [{ item_id: id.cessed!, qty: 3 }]);
    expect(local).toMatchObject({ taxable_total: '3000.00', cgst_total: '420.00', sgst_total: '420.00', cess_total: '360.00', grand_total: '4200.00' });
    id.invCess = local.id;
    const doc = (await (await w.as('sales')).get(`/api/sales/invoices/${local.id}`).expect(200)).body.data;
    expect(doc.lines[0]).toMatchObject({ gst_rate: '28.00', cess_rate: '12.00', cess: '360.00', line_total: '4200.00' });
    expect(doc.hsn_summary[0]).toMatchObject({ hsn_sac: '220299', cess: '360.00' });
    // To Karnataka: ₹1,000; IGST 280 + cess 120 = ₹1,400.
    const away = await sell(id.away!, [{ item_id: id.cessed!, qty: 1 }]);
    expect(away).toMatchObject({ taxable_total: '1000.00', igst_total: '280.00', cess_total: '120.00', grand_total: '1400.00' });
  });

  it('backs GST and cess out of a retail price at the counter', async () => {
    // ₹1,400 including tax: taxable 1,000, CGST 140, SGST 140, cess 120.
    const res = await (await w.as('store')).post('/api/sales/quick-bill').send({ lines: [{ item_id: id.cessed, qty: 1 }], payments: [{ mode: 'cash', amount: 1400 }] }).expect(201);
    expect(res.body.data.invoice).toMatchObject({ taxable_total: '1000.00', cgst_total: '140.00', sgst_total: '140.00', cess_total: '120.00', grand_total: '1400.00' });
  });

  it('a credit note takes the cess back with the goods', async () => {
    const accounts = await w.as('accounts');
    const doc = (await accounts.get(`/api/sales/invoices/${id.invCess}`).expect(200)).body.data;
    // 1 of the 3 back: ₹1,000 + 140 + 140 + 120 = ₹1,400.
    const cn = await accounts.post(`/api/sales/invoices/${id.invCess}/credit-note`).send({
      lines: [{ invoice_line_id: doc.lines[0].id, qty: 1 }], restock: true, reason: 'Returned unopened',
    }).expect(201);
    expect(cn.body.data).toMatchObject({ taxable_total: '1000.00', cess_total: '120.00', grand_total: '1400.00' });
  });

  it('posts cess to Output Cess, and the books still balance', async () => {
    // 360 + 120 + 120 billed, 120 taken back = ₹480.
    expect(await balance('output_cess')).toBe('480.00');
    await expectBooksHealthy(w);
  });
});

describe('the returns', () => {
  it('GSTR-1 carries cess in B2B and the HSN summary, net of the credit note', async () => {
    const gst = (await (await w.as('accounts')).get(`/api/gst/gstr1?month=${MONTH}`).expect(200)).body.data;
    const b2bCess = gst.b2b.filter((r: any) => r.hsn === undefined && Number(r.cess) > 0).map((r: any) => [r.receiver_name, r.cess]);
    expect(b2bCess).toEqual([['Pune Motors', '360.00'], ['Bengaluru Motors', '120.00']]);
    const hsn = gst.hsn.find((h: any) => h.hsn === '220299');
    // Billed 3 + 1 + 1 = 5, 1 back: 4 units, taxable 4,000, cess 360 + 120 + 120 - 120 = 480.
    expect(hsn).toMatchObject({ rate: '28.00', total_qty: '4.000', taxable_value: '4000.00', cess: '480.00' });
    const forty = gst.hsn.find((h: any) => h.hsn === '870380');
    expect(forty).toMatchObject({ rate: '40.00', taxable_value: '20000.00', cgst: '4000.00', sgst: '4000.00', cess: '0.00' });
  });

  it('the portal file puts cess in csamt, and GSTR-3B adds it to the tax', async () => {
    const accounts = await w.as('accounts');
    await (await w.as('admin')).put('/api/settings/company').send({
      name: 'Radboards Pvt Ltd', gstin: gstin('27', 'AAPFU0939F'), state_code: '27', address: { line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    }).expect(200);
    const file = JSON.parse((await accounts.get(`/api/gst/gstr1/portal-file?month=${MONTH}`).expect(200)).text);
    const hsnRow = [...file.hsn.hsn_b2b, ...file.hsn.hsn_b2c].filter((h: any) => h.hsn_sc === '220299').reduce((t: number, h: any) => t + h.csamt, 0);
    expect(hsnRow).toBe(480);
    const local = file.b2b.find((b: any) => b.ctin === gstin('27', 'LOCAL1234A'));
    expect(local.inv.flatMap((i: any) => i.itms.map((x: any) => x.itm_det.csamt))).toContain(360);

    const b3 = (await accounts.get(`/api/gst/gstr3b?month=${MONTH}`).expect(200)).body.data;
    expect(b3.outward.net.cess).toBe('480.00');
    // Output tax: GST 8,000 (40% bill) + 840 + 280 + 280 - 280 (cessed goods, credit note back) + cess 480.
    expect(b3.outward.total_tax).toBe('9600.00');
  });
});
