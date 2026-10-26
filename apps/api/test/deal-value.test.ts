import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@radcore/shared';
import { sql } from '../src/db/client';
import { masters, openingStock, setup, type World } from './helpers';

/**
 * The pipeline board with deal values (CRM → Pipeline), the counters above the order lists, and
 * what a product's own page shows about it (Stores → Products).
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  // A board sold at 1,180 with GST to retail customers, 1,000 before GST to dealers.
  id.board = (await admin.post('/api/items').send({ sku: 'DV-1', name: 'Cruiser board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
    retail_price: 1180, dealer_price: 1000, purchase_cost: 500 }).expect(201)).body.data.id;
  await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '20', unit_cost: '500.00' }]);
  id.dealer = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Pune Boards', phone: '9820055599' }).expect(201)).body.data.id;
});
afterAll(() => w.close());

const board = async () => (await (await w.as('sales')).get('/api/leads/pipeline').expect(200)).body;
const card = async (leadId: string) => ((await board()).data as any[]).find((l) => l.id === leadId);

describe('deal value on a lead', () => {
  it('counts the items asked about until someone sets a deal value, then the deal value', async () => {
    const sales = await w.as('sales');
    id.lead = (await sales.post('/api/leads').send({ name: 'Ravi Shop', phone: '9820055501', source_id: m.source('Meta Ads'), interested_item_ids: [id.board] }).expect(201)).body.data.id;
    expect(await card(id.lead!)).toMatchObject({ value: '1180.00', value_from: 'items', deal_value: null });

    await sales.patch(`/api/leads/${id.lead}`).send({ deal_value: '45000' }).expect(200);
    expect(await card(id.lead!)).toMatchObject({ value: '45000.00', value_from: 'deal', deal_value: '45000.00' });

    // Blank takes it back to the items.
    await sales.patch(`/api/leads/${id.lead}`).send({ deal_value: '' }).expect(200);
    expect(await card(id.lead!)).toMatchObject({ value: '1180.00', value_from: 'items' });
  });

  it('refuses a deal value that is not a sensible amount', async () => {
    const sales = await w.as('sales');
    await sales.patch(`/api/leads/${id.lead}`).send({ deal_value: '-5' }).expect(400);
    await sales.patch(`/api/leads/${id.lead}`).send({ deal_value: 'lots' }).expect(400);
    await sales.patch(`/api/leads/${id.lead}`).send({ deal_value: '99999999999' }).expect(400);
  });

  it('shows the quotes and orders made for the lead, with their value before GST', async () => {
    const sales = await w.as('sales');
    const order = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lead_id: id.lead, lines: [{ item_id: id.board, qty: 3 }] }).expect(201)).body.data;
    const lead = (await sales.get(`/api/leads/${id.lead}`).expect(200)).body.data;
    expect(lead.orders).toHaveLength(1);
    expect(lead.orders[0]).toMatchObject({ id: order.id, status: 'draft' });
    expect(Number(lead.orders[0].amount)).toBeGreaterThan(0);
  });
});

describe('the pipeline board', () => {
  it('has a column for won and lost leads as well as the open stages', async () => {
    expect((await board()).stages).toEqual([
      'new', 'contacted', 'interested', 'meeting_booked', 'test_ride_booked', 'test_ride_done', 'quoted', 'booked', 'delivered', 'converted', 'lost',
    ]);
  });

  it('shows leads won or lost in the last 30 days, not older ones', async () => {
    const sales = await w.as('sales');
    const won = (await sales.post('/api/leads').send({ name: 'Won Lead', phone: '9820055502', source_id: m.source('Meta Ads') }).expect(201)).body.data.id;
    await sales.post(`/api/leads/${won}/convert`).send({ party_type: 'customer' }).expect(200);
    const lost = (await sales.post('/api/leads').send({ name: 'Lost Lead', phone: '9820055503', source_id: m.source('Meta Ads') }).expect(201)).body.data.id;
    await sales.post(`/api/leads/${lost}/stage`).send({ stage: 'lost', lost_reason_id: m.lostReason('Price') }).expect(200);
    expect((await card(won))?.stage).toBe('converted');
    expect((await card(lost))?.stage).toBe('lost');
    expect((await card(lost))?.overdue).toBe(false);

    await w.db.execute(sql`update leads set updated_at = now() - interval '40 days' where id = ${lost}`);
    await w.db.execute(sql`update leads set converted_at = now() - interval '40 days' where id = ${won}`);
    expect(await card(lost)).toBeUndefined();
    expect(await card(won)).toBeUndefined();
  });

  it('moves a card with the same rules as the lead page: lost needs a reason, the follow-up stages a date', async () => {
    const sales = await w.as('sales');
    const lead = (await sales.post('/api/leads').send({ name: 'Drag Me', phone: '9820055504', source_id: m.source('Meta Ads') }).expect(201)).body.data;
    await sales.post(`/api/leads/${lead.id}/stage`).send({ stage: 'lost' }).expect(400);
    await sales.post(`/api/leads/${lead.id}/stage`).send({ stage: 'interested' }).expect(200); // it already has a follow-up date
    expect((await card(lead.id)).stage).toBe('interested');
    await sales.post(`/api/leads/${lead.id}/stage`).send({ stage: 'converted' }).expect(400); // won is reached by converting
  });
});

describe('counters above the order lists', () => {
  it('counts sales orders and purchase orders by status', async () => {
    const sales = await w.as('sales');
    const before = (await sales.get('/api/sales/orders/summary').expect(200)).body.data;
    const o = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 1 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${o.id}/confirm`).send({}).expect(200);
    const after = (await sales.get('/api/sales/orders/summary').expect(200)).body.data;
    expect((after.confirmed ?? 0) - (before.confirmed ?? 0)).toBe(1);

    const stores = await w.as('stores');
    expect((await stores.get('/api/purchasing/orders/summary').expect(200)).body.data).toEqual({});
    await (await w.as('marketing')).get('/api/purchasing/orders/summary').expect(403);
  });
});

describe('a product\'s own page', () => {
  it('shows what was sold, what is waiting to go out, its price-list rates and its last stock movements', async () => {
    const sales = await w.as('sales');
    const stores = await w.as('stores');
    const today = istDate();
    // Two sold and invoiced, then one more confirmed but not yet delivered.
    const sold = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, order_date: today, lines: [{ item_id: id.board, qty: 2 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${sold.id}/confirm`).send({}).expect(200);
    await stores.post(`/api/sales/orders/${sold.id}/deliver`).send({ location_id: m.stores }).expect(201);
    await sales.post(`/api/sales/orders/${sold.id}/invoice`).send({ invoice_date: today }).expect(201);
    const waiting = (await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 4 }] }).expect(201)).body.data;
    await sales.post(`/api/sales/orders/${waiting.id}/confirm`).send({}).expect(200);

    const item = (await sales.get(`/api/items/${id.board}`).expect(200)).body.data;
    expect(Number(item.activity.sold_qty)).toBe(2);
    expect(Number(item.activity.sold_value)).toBe(2000);
    // The order confirmed in the counter test above (1) and this one (4).
    expect(Number(item.activity.to_deliver)).toBe(5);
    expect(Number(item.activity.to_receive)).toBe(0);
    expect(item.movements[0]).toMatchObject({ movement_type: 'sale_out' });
    expect(Number(item.movements[0].qty)).toBe(-2);
    expect(item.movements.at(-1)).toMatchObject({ movement_type: 'opening' });
    expect(Array.isArray(item.price_list_rates)).toBe(true);
  });
});
