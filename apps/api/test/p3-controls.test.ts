import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

/**
 * P3 of the brief: a purchase order above its sender's limit waits for approval, and reads of the cost and
 * margin reports are audited beside the changes.
 *
 *   Stores may send a PO of up to ₹50,000 with GST. 40 boards at ₹1,000 + 18% GST = ₹47,200 goes straight out;
 *   50 boards = ₹59,000 waits for the owner.
 */
let w: World;
const id: Record<string, string> = {};
const status = async (poId: string | undefined) => (await rows<{ status: string }>(w.db, sql`select status::text from purchase_orders where id = ${poId}`))[0]!.status;

beforeAll(async () => {
  w = await setup();
  const admin = await w.as('admin');
  id.board = (await admin.post('/api/items').send({ sku: 'BRD-1', name: 'Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, purchase_cost: 1000 }).expect(201)).body.data.id;
  id.supplier = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Deck Makers', phone: '9700000091' }).expect(201)).body.data.id;
});
afterAll(() => w.close());

describe('purchase order approval by amount', () => {
  const po = async (qty: number) => (await (await w.as('stores')).post('/api/purchasing/orders').send({ supplier_id: id.supplier, lines: [{ item_id: id.board, qty, rate: 1000 }] }).expect(201)).body.data.id as string;

  it('is set per role by an admin', async () => {
    await (await w.as('stores')).put('/api/purchasing/approval-limits').send({ limits: [{ role: 'stores', max_amount: 50000 }] }).expect(403);
    const res = await (await w.as('admin')).put('/api/purchasing/approval-limits').send({ limits: [{ role: 'stores', max_amount: 50000 }] }).expect(200);
    expect(res.body.data).toEqual([expect.objectContaining({ role: 'stores', max_amount: '50000.00' })]);
  });

  it('sends a PO within the limit, and holds one over it until it is approved', async () => {
    const stores = await w.as('stores');
    id.small = await po(40);
    await stores.post(`/api/purchasing/orders/${id.small}/send`).send({}).expect(200);
    expect(await status(id.small)).toBe('sent');
    id.big = await po(50);
    await stores.post(`/api/purchasing/orders/${id.big}/send`).send({}).expect(200);
    expect(await status(id.big)).toBe('pending_approval');
    // Nothing can be received or billed against it while it waits.
    const line = (await stores.get(`/api/purchasing/orders/${id.big}`).expect(200)).body.data.lines[0].id;
    await stores.post('/api/purchasing/receipts').send({ purchase_order_id: id.big, lines: [{ po_line_id: line, received_qty: 1 }] }).expect(409);
    await stores.post(`/api/purchasing/orders/${id.big}/approve`).send({}).expect(403);
    await (await w.as('owner')).post(`/api/purchasing/orders/${id.big}/approve`).send({}).expect(200);
    expect(await status(id.big)).toBe('sent');
  });

  it('can be sent back to draft with the reason', async () => {
    id.again = await po(60);
    await (await w.as('stores')).post(`/api/purchasing/orders/${id.again}/send`).send({}).expect(200);
    await (await w.as('owner')).post(`/api/purchasing/orders/${id.again}/reject`).send({}).expect(400);
    await (await w.as('owner')).post(`/api/purchasing/orders/${id.again}/reject`).send({ reason: 'Order 30 now, 30 next month' }).expect(200);
    expect(await status(id.again)).toBe('draft');
    const [entry] = await rows<{ after: { rejected?: string } }>(w.db, sql`
      select after from audit_log where entity = 'purchase_order' and entity_id = ${id.again} order by id desc limit 1`);
    expect(entry!.after.rejected).toBe('Order 30 now, 30 next month');
  });
});

describe('reads of the cost and margin reports', () => {
  it('are audited with who, which report and the filters', async () => {
    const accounts = await w.as('accounts');
    await accounts.get('/api/stock/valuation').expect(200);
    await accounts.get('/api/accounting/reports/party-profit?from=2026-04-01').expect(200);
    await (await w.as('sales')).get('/api/stock/valuation').expect(403);
    // The entry is written as the answer goes out.
    await new Promise((r) => setTimeout(r, 50));
    const reads = await rows<{ entity_id: string; role: string; after: { query: Record<string, string> } }>(w.db, sql`
      select a.entity_id, u.role::text, a.after from audit_log a join users u on u.id = a.user_id where a.entity = 'report' and a.action = 'read' order by a.id`);
    expect(reads.map((r) => [r.entity_id, r.role])).toEqual([['stock_valuation', 'accounts'], ['party_profit', 'accounts']]);
    expect(reads[1]!.after.query).toEqual({ from: '2026-04-01' });
  });
});
