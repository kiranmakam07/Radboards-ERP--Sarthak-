import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toWorkbook } from '../src/lib/xlsx';
import { masters, openingStock, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

/** Read the files back out of a zip written by our own writer (an .xlsx is one). */
function unzip(buf: Buffer): Record<string, string> {
  const files: Record<string, string> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const packed = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    files[name] = zlib.inflateRawSync(buf.subarray(start, start + packed)).toString('utf8');
    at = start + packed;
  }
  return files;
}
const sheetNames = (files: Record<string, string>) => [...files['xl/workbook.xml']!.matchAll(/<sheet name="([^"]+)"/g)].map((x) => x[1]);
const download = async (role: Parameters<World['as']>[0]) =>
  (await w.as(role)).get('/api/masters/export').buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
});
afterAll(() => w.close());

describe('masters: changed in one place, by an admin', () => {
  it('keeps the item list to an admin, while everyone else reads it', async () => {
    const admin = await w.as('admin');
    const body = { sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 5900, dealer_price: 4000, purchase_cost: 2500, barcode: '8901234567890' };
    for (const role of ['stores', 'accounts', 'sales', 'owner'] as const) await (await w.as(role)).post('/api/items').send(body).expect(403);
    id.board = (await admin.post('/api/items').send(body).expect(201)).body.data.id;
    for (const role of ['stores', 'accounts'] as const) await (await w.as(role)).patch(`/api/items/${id.board}`).send({ retail_price: 1 }).expect(403);
    await (await w.as('stores')).post('/api/masters/item-categories').send({ name: 'Boards' }).expect(403);
    await (await w.as('sales')).get(`/api/items/${id.board}`).expect(200);
  });

  it('lets staff add a customer while working, but not set terms or change one afterwards', async () => {
    const sales = await w.as('sales');
    const admin = await w.as('admin');
    const walkIn = (await sales.post('/api/parties').send({ party_type: 'customer', name: 'Rhea Menon', phone: '9820011111' }).expect(201)).body.data;
    id.rhea = walkIn.id;
    expect(walkIn).toMatchObject({ credit_limit: null, price_list_id: null, payment_terms_days: null });
    const refused = await sales.post('/api/parties').send({ party_type: 'dealer', name: 'Easy Credit Traders', phone: '9820022222', credit_limit: 500000 }).expect(403);
    expect(refused.body.error.message).toMatch(/Masters/);
    await sales.post('/api/parties').send({ party_type: 'dealer', name: 'Easy Credit Traders', phone: '9820022222', payment_terms_days: 90 }).expect(403);
    await sales.patch(`/api/parties/${id.rhea}`).send({ credit_limit: 500000 }).expect(403);
    await (await w.as('accounts')).patch(`/api/parties/${id.rhea}`).send({ name: 'Someone Else' }).expect(403);

    const dealer = await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Bangalore Boards', phone: '9820033333', credit_limit: 60000, payment_terms_days: 15 }).expect(201);
    id.dealer = dealer.body.data.id;
    id.supplier = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Deck Makers', phone: '9820044444', payment_terms_days: 30 }).expect(201)).body.data.id;
    expect((await admin.patch(`/api/parties/${id.rhea}`).send({ email: 'rhea@example.com' }).expect(200)).body.data.email).toBe('rhea@example.com');
  });

  it('keeps the employee record to an admin, while HR still runs its own work on it', async () => {
    const hr = await w.as('hr');
    const admin = await w.as('admin');
    const body = { name: 'Arjun Mehta', phone: '9833000001', department: 'Stores', designation: 'Stores Assistant', join_date: '2026-01-05', monthly_salary: 22000 };
    await hr.post('/api/hr/employees').send(body).expect(403);
    await (await w.as('accounts')).post('/api/hr/employees').send(body).expect(403);
    id.arjun = (await admin.post('/api/hr/employees').send(body).expect(201)).body.data.id;
    id.meera = (await admin.post('/api/hr/employees').send({ ...body, name: 'Meera Shah', phone: '9833000002', department: 'Sales', designation: 'Executive' }).expect(201)).body.data.id;
    await hr.patch(`/api/hr/employees/${id.arjun}`).send({ monthly_salary: 99000 }).expect(403);
    await hr.put(`/api/payroll/staff/${id.arjun}`).send({ monthly_salary: 99000, pf_applicable: false, esic_applicable: false, pt_monthly: 0, tds_monthly: 0, bank_account_no: '', bank_ifsc: '' }).expect(403);
    // HR reads the record and marks attendance against it as before.
    expect((await hr.get(`/api/hr/employees/${id.arjun}`).expect(200)).body.data.monthly_salary).toBe('22000.00');
    await hr.put('/api/hr/attendance').send({ date: '2026-01-06', entries: [{ employee_id: id.arjun, status: 'present' }] }).expect(200);
  });

  it('shows a change made once on every screen that reads the master', async () => {
    const admin = await w.as('admin');
    await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '10', unit_cost: '2500.00' }]);
    await admin.patch(`/api/items/${id.board}`).send({ name: 'Cruiser Board 32"', retail_price: 6490 }).expect(200);
    const scanned = (await (await w.as('store')).get('/api/items/lookup?code=8901234567890').expect(200)).body.data;
    expect(scanned).toMatchObject({ name: 'Cruiser Board 32"', retail_price: '6490.00' });
    const stock = (await (await w.as('stores')).get('/api/items?q=BRD-1').expect(200)).body.data[0];
    expect(stock).toMatchObject({ name: 'Cruiser Board 32"', on_hand: '10.000' });

    await admin.patch(`/api/hr/employees/${id.arjun}`).send({ department: 'Workshop', monthly_salary: 24000 }).expect(200);
    const paid = (await (await w.as('accounts')).get('/api/payroll/staff').expect(200)).body.data.find((e: any) => e.id === id.arjun);
    expect(paid).toMatchObject({ department: 'Workshop', monthly_salary: '24000.00' });
  });

  it('lets an admin hand one master to another role from Permissions', async () => {
    const hr = await w.as('hr');
    const admin = await w.as('admin');
    await admin.put('/api/settings/permissions/employees:manage').send({ roles: ['hr'] }).expect(200);
    await hr.patch(`/api/hr/employees/${id.meera}`).send({ designation: 'Senior Executive' }).expect(200);
    await hr.post('/api/items').send({ sku: 'X-1', name: 'x', item_type: 'service', gst_rate: 18 }).expect(403); // only the master that was handed over
    await admin.put('/api/settings/permissions/employees:manage').send({ roles: [] }).expect(200);
    await hr.patch(`/api/hr/employees/${id.meera}`).send({ designation: 'Executive' }).expect(403);
  });
});

describe('masters: the whole set in one place', () => {
  it('counts each master', async () => {
    const admin = await w.as('admin');
    await admin.patch(`/api/parties/${id.rhea}`).send({ active: false }).expect(200);
    const s = (await admin.get('/api/masters/summary').expect(200)).body.data;
    expect(s).toMatchObject({ items: 1, items_inactive: 0, customers: 1, suppliers: 1, employees: 2, employees_left: 0 });
    expect(s.items_changed_at).toBeTruthy();
    await (await w.as('accounts')).get('/api/masters/summary').expect(403);
  });

  it('downloads every master as one workbook, a sheet each', async () => {
    for (const role of ['owner', 'accounts', 'hr', 'stores'] as const) await (await w.as(role)).get('/api/masters/export').expect(403);
    const res = await download('admin');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/radcore-masters-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const files = unzip(res.body as Buffer);
    expect(sheetNames(files)).toEqual(['Items', 'Customers', 'Suppliers', 'Employees']);
    // Sheet 1 is the items, with the barcode kept as text and the price as a number.
    expect(files['xl/worksheets/sheet1.xml']).toContain('<t>SKU</t>');
    expect(files['xl/worksheets/sheet1.xml']).toContain('<t>HSN SAC</t>');
    expect(files['xl/worksheets/sheet1.xml']).toContain('finished good');
    expect(files['xl/worksheets/sheet1.xml']).toContain('<t xml:space="preserve">8901234567890</t>');
    expect(files['xl/worksheets/sheet1.xml']).toContain('<v>6490.00</v>');
    // Customers and dealers together (including the one switched off); suppliers on their own sheet.
    expect(files['xl/worksheets/sheet2.xml']).toContain('Bangalore Boards');
    expect(files['xl/worksheets/sheet2.xml']).toContain('Rhea Menon');
    expect(files['xl/worksheets/sheet2.xml']).not.toContain('Deck Makers');
    expect(files['xl/worksheets/sheet3.xml']).toContain('Deck Makers');
    expect(files['xl/worksheets/sheet4.xml']).toContain('Arjun Mehta');
    expect(files['xl/worksheets/sheet4.xml']).toContain('<v>24000.00</v>');
    // Every sheet is declared, or Excel refuses the file.
    for (const n of [1, 2, 3, 4]) expect(files['[Content_Types].xml']).toContain(`/xl/worksheets/sheet${n}.xml`);
    expect(files['xl/_rels/workbook.xml.rels']).toContain('Target="styles.xml"');
  });

  it('leaves salaries out for someone who may not change employees', async () => {
    const admin = await w.as('admin');
    await admin.put('/api/settings/permissions/masters:manage').send({ roles: ['accounts'] }).expect(200);
    const files = unzip((await download('accounts')).body as Buffer);
    expect(sheetNames(files)).toEqual(['Items', 'Customers', 'Suppliers']);
    expect(Object.values(files).join('')).not.toContain('Arjun Mehta');
    await admin.put('/api/settings/permissions/masters:manage').send({ roles: [] }).expect(200);
    await (await w.as('accounts')).get('/api/masters/export').expect(403);
  });

  it('records each download in the audit trail', async () => {
    const log = (await (await w.as('admin')).get('/api/settings/audit-log?entity=masters').expect(200)).body.data;
    expect(log.length).toBe(2);
    expect(log[0]).toMatchObject({ action: 'export', user_name: 'accounts user' });
  });
});

describe('the workbook writer', () => {
  it('gives every sheet a name Excel accepts, with no two alike', () => {
    const files = unzip(toWorkbook([
      { name: 'Items', rows: [{ a: 1 }] }, { name: 'items', rows: [] }, { name: 'A/B:C', rows: [] }, { name: '', rows: [] },
      { name: 'x'.repeat(40), rows: [] },
    ]));
    expect(sheetNames(files)).toEqual(['Items', 'items 2', 'A B C', 'Sheet4', 'x'.repeat(31)]);
    expect(() => toWorkbook([])).toThrow();
  });
});
