import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stateCodeFor } from '@radcore/shared';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import { fromShopify, parseOrderFile } from '../src/modules/online';
import { expectBooksHealthy, masters, openingStock, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;

const SECRET = 'test-shopify-secret';
/** Post a webhook exactly as Shopify does: raw JSON bytes, the topic, and a base64 signature over those bytes. */
const fromShopifyStore = (topic: string, body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return request(w.app).post('/api/hooks/shopify').set('Content-Type', 'application/json').set('X-Shopify-Topic', topic)
    .set('X-Shopify-Hmac-Sha256', crypto.createHmac('sha256', secret).update(raw).digest('base64')).send(raw);
};
const orderBy = async (channel: string, externalId: string) =>
  (await rows<Record<string, any>>(w.db, sql`
    select o.*, p.name as party_name, p.phone as party_phone, p.state_code as party_state, p.lead_id as party_lead
      from sales_orders o left join parties p on p.id = o.party_id where o.channel::text = ${channel} and o.external_order_id = ${externalId}`))[0] as Record<string, any>;
const eventFor = async (channel: string, type: string, externalId: string) =>
  (await rows<Record<string, any>>(w.db, sql`select * from channel_events where channel = ${channel} and event_type = ${type} and external_id = ${externalId}`))[0] as Record<string, any>;
const count = async (table: 'sales_orders' | 'parties') =>
  (await rows<{ n: number }>(w.db, table === 'parties' ? sql`select count(*)::int as n from parties` : sql`select count(*)::int as n from sales_orders`))[0]!.n;

/** A Shopify order as its webhook sends it (only the fields that matter here). Prices include GST. */
const shopifyOrder = (over: Record<string, unknown> = {}) => ({
  id: 5001, name: '#1001', created_at: '2026-10-11T22:10:00+05:30', currency: 'INR', taxes_included: true,
  total_price: '5999.00', financial_status: 'paid', payment_gateway_names: ['razorpay'], note: 'Please gift wrap',
  email: 'Asha@Example.com',
  customer: { first_name: 'Asha', last_name: 'Rao', phone: '+91 98200 11111', email: 'asha@example.com' },
  shipping_address: { name: 'Asha Rao', phone: '09820011111', address1: '4 MG Road', address2: 'Flat 2', city: 'Bengaluru', province: 'Karnataka', province_code: 'KA', zip: '560001', country_code: 'IN' },
  line_items: [{ sku: 'brd-cruiser', title: 'Cruiser Board', variant_title: '27 inch', quantity: 1, price: '5900.00', discount_allocations: [] }],
  shipping_lines: [{ price: '99.00', discounted_price: '99.00' }],
  ...over,
});

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const item = async (sku: string, name: string, price: number, gst = 18) =>
    (await admin.post('/api/items').send({ sku, name, item_type: 'finished_good', hsn_sac: '950699', gst_rate: gst, retail_price: price, purchase_cost: Math.round(price / 2) }).expect(201)).body.data.id as string;
  const cruiser = await item('BRD-CRUISER', 'Cruiser Board 27"', 5900);
  const helmet = await item('HLM-01', 'Helmet', 1534);
  await openingStock(w, m.stores, [{ item_id: cruiser, qty_change: '20', unit_cost: '2500.00' }, { item_id: helmet, qty_change: '20', unit_cost: '700.00' }]);
  config.shopifyWebhookSecret = SECRET;
});
afterAll(async () => {
  config.shopifyWebhookSecret = '';
  await w.close();
});

describe('reading orders', () => {
  it('reads a state however it is written', () => {
    expect(stateCodeFor('KA')).toBe('29');
    expect(stateCodeFor('IN-MH')).toBe('27');
    expect(stateCodeFor('karnataka')).toBe('29');
    expect(stateCodeFor('Jammu and Kashmir')).toBe('01');
    expect(stateCodeFor('Andaman & Nicobar Islands')).toBe('35');
    expect(stateCodeFor('ORISSA')).toBe('21');
    expect(stateCodeFor('7')).toBe('07');
    expect(stateCodeFor('Atlantis')).toBeNull();
    expect(stateCodeFor('')).toBeNull();
  });

  it('reads a Shopify order: who, where, what, and how it was paid', () => {
    const o = fromShopify(shopifyOrder({ line_items: [{ sku: 'HLM-01', title: 'Helmet', quantity: 2, price: '1534.00', discount_allocations: [{ amount: '100.00' }, { amount: '53.40' }] }] }));
    expect(o).toMatchObject({
      channel: 'shopify', externalId: '5001', name: '#1001', orderDate: '2026-10-11', currency: 'INR', taxInclusive: true, shipping: '99.00', total: '5999.00',
      customer: { name: 'Asha Rao', phone: '+919820011111', email: 'asha@example.com' },
      address: { line1: '4 MG Road', city: 'Bengaluru', state: 'KA', pincode: '560001' },
      payment: 'paid', paymentNote: 'Paid online (razorpay)', note: 'Please gift wrap',
    });
    expect(o.lines).toEqual([{ sku: 'HLM-01', title: 'Helmet', qty: '2', unitPrice: '1534.00', discount: '153.40' }]);
    // An order placed late in the evening in India belongs to that day, not the next one in UTC or the one before.
    expect(fromShopify(shopifyOrder({ created_at: '2026-10-11T20:30:00Z' })).orderDate).toBe('2026-10-12');
    expect(fromShopify(shopifyOrder({ financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] })).paymentNote).toBe('Not paid yet (Cash on Delivery (COD)): collect on delivery');
  });

  it('reads an Amazon order report (tab-separated, one row per item)', () => {
    const file = [
      'amazon-order-id\tpurchase-date\torder-status\tsku\tproduct-name\tquantity\titem-price\tshipping-price\tship-city\tship-state\tship-postal-code\trecipient-name',
      '402-1111111-0000001\t2026-10-10T19:45:00+00:00\tShipped\tBRD-CRUISER\tCruiser Board\t2\t11800.00\t0\tPune\tMAHARASHTRA\t411001\tRohit K',
      '402-1111111-0000001\t2026-10-10T19:45:00+00:00\tShipped\tHLM-01\tHelmet\t1\t1534.00\t60.00\tPune\tMAHARASHTRA\t411001\tRohit K',
      '402-2222222-0000002\t2026-10-11T03:00:00+00:00\tCancelled\tHLM-01\tHelmet\t1\t1534.00\t0\tDelhi\tDELHI\t110001\tSomeone',
    ].join('\n');
    const { orders, skipped } = parseOrderFile('amazon', file);
    expect(skipped).toBe(1);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      channel: 'amazon', externalId: '402-1111111-0000001', orderDate: '2026-10-11', shipping: '60.00', taxInclusive: true,
      customer: { name: 'Rohit K', phone: null }, address: { city: 'Pune', state: 'MAHARASHTRA', pincode: '411001' },
    });
    // The report gives what the customer pays for the row; the order needs the price of one.
    expect(orders[0]!.lines).toEqual([
      { sku: 'BRD-CRUISER', title: 'Cruiser Board', qty: '2', unitPrice: '5900.00', discount: '0.00' },
      { sku: 'HLM-01', title: 'Helmet', qty: '1', unitPrice: '1534.00', discount: '0.00' },
    ]);
  });

  it('reads a Flipkart order report (comma-separated, other column names) and says what is missing in a wrong file', () => {
    const file = 'Order Id,Ordered On,SKU,Product,Quantity,Selling Price Per Item,Shipping Charge,Buyer Name,City,State,PIN Code,Order Item Status\r\n'
      + 'OD429000000000001,11-10-2026,HLM-01,"Helmet, black",3,"1,534.00",0,Meera,Kochi,Kerala,682001,APPROVED\r\n';
    const { orders } = parseOrderFile('flipkart', file);
    expect(orders[0]).toMatchObject({ channel: 'flipkart', externalId: 'OD429000000000001', orderDate: '2026-10-11', address: { state: 'Kerala' } });
    expect(orders[0]!.lines).toEqual([{ sku: 'HLM-01', title: 'Helmet, black', qty: '3', unitPrice: '1534.00', discount: '0.00' }]);
    expect(() => parseOrderFile('flipkart', 'Date,Narration,Debit,Credit\n01-10-2026,UPI,100,0\n')).toThrow(/order number, the SKU, the quantity, the price/);
    expect(() => parseOrderFile('amazon', 'order-id,sku,quantity,item-price\nA1,HLM-01,zero,10\n')).toThrow(/Row 2: the quantity/);
  });
});

describe('Shopify orders', () => {
  it('refuses anything Shopify did not sign', async () => {
    await fromShopifyStore('orders/create', shopifyOrder(), 'someone-elses-secret').expect(403);
    await request(w.app).post('/api/hooks/shopify').send(shopifyOrder()).expect(403);
    config.shopifyWebhookSecret = '';
    await fromShopifyStore('orders/create', shopifyOrder()).expect(503);
    config.shopifyWebhookSecret = SECRET;
    expect(await count('sales_orders')).toBe(0);
  });

  it('turns a new order into a confirmed sales order for that customer, ready to deliver', async () => {
    await fromShopifyStore('orders/create', shopifyOrder()).expect(200);
    const o = await orderBy('shopify', '5001');
    expect(o).toMatchObject({ status: 'confirmed', order_date: '2026-10-11', place_of_supply: '29', tax_inclusive: true, party_name: 'Asha Rao', party_phone: '+919820011111', party_state: '29' });
    expect(o.notes).toBe("Shopify #1001. Paid online (razorpay). Customer's note: Please gift wrap");

    const detail = (await (await w.as('sales')).get(`/api/sales/orders/${o.id}`).expect(200)).body.data;
    expect(detail.lines.map((l: any) => [l.sku, Number(l.qty), l.rate, l.discount])).toEqual([['BRD-CRUISER', 1, '5900.00', '0.00'], ['SHIPPING', 1, '99.00', '0.00']]);
    // Karnataka from Maharashtra: IGST, worked back out of prices that already include it. The total is what the customer paid.
    expect(detail.totals).toMatchObject({ grand_total: '5999.00', cgst_total: '0.00', sgst_total: '0.00', igst_total: '915.10', taxable_total: '5083.90' });

    const e = await eventFor('shopify', 'order', '5001');
    expect(e).toMatchObject({ status: 'processed', order_id: o.id, lead_id: null, error: null });
    expect(e.summary).toBe(`Shopify #1001 · Asha Rao · ₹5,999.00 · ${o.order_no}`);

    // It then goes down the usual road: delivered from stores, invoiced, and the books still agree.
    const sales = await w.as('sales');
    await (await w.as('stores')).post(`/api/sales/orders/${o.id}/deliver`).send({ location_id: m.stores }).expect(201);
    const invoice = await sales.post(`/api/sales/orders/${o.id}/invoice`).send({}).expect(201);
    expect(invoice.body.data.grand_total).toBe('5999.00');
    await expectBooksHealthy(w);
  });

  it('takes the same order in once, however often Shopify sends it', async () => {
    const before = await count('sales_orders');
    await fromShopifyStore('orders/create', shopifyOrder()).expect(200);
    await fromShopifyStore('orders/paid', shopifyOrder()).expect(200);
    await fromShopifyStore('orders/updated', shopifyOrder({ note: 'changed my mind about the wrap' })).expect(200);
    expect(await count('sales_orders')).toBe(before);
    // A kind of message we do not use is acknowledged and dropped, so Shopify does not keep resending it.
    await fromShopifyStore('products/update', { id: 77 }).expect(200);
    expect((await rows(w.db, sql`select 1 from channel_events where external_id = '77'`))).toHaveLength(0);
  });

  it('keeps an order it cannot take in, says why, and takes it in once the reason is fixed', async () => {
    const order = shopifyOrder({
      id: 5002, name: '#1002', total_price: '2499.00', shipping_lines: [],
      customer: { first_name: 'Vikram', last_name: 'Shah', phone: '9820022222' }, email: null,
      shipping_address: { name: 'Vikram Shah', address1: '1 FC Road', city: 'Pune', province: 'Maharashtra', province_code: 'MH', zip: '411004' },
      line_items: [{ sku: 'KNEE-PAD', title: 'Knee pads', quantity: 1, price: '2499.00' }],
    });
    await fromShopifyStore('orders/create', order).expect(200);
    expect(await orderBy('shopify', '5002')).toBeUndefined();
    const e = await eventFor('shopify', 'order', '5002');
    expect(e.status).toBe('failed');
    expect(e.error).toBe('Shopify #1002: no item here has the SKU KNEE-PAD (Knee pads). Add the item or correct its SKU, then try again.');
    expect(await rows(w.db, sql`select 1 from parties where phone = '+919820022222'`)).toHaveLength(0); // nothing half-done is left behind

    const sales = await w.as('sales');
    const screen = (await sales.get('/api/sales/online').expect(200)).body.data;
    expect(screen.shopify.connected).toBe(true);
    expect(screen.events[0]).toMatchObject({ channel: 'shopify', status: 'failed', summary: 'Shopify #1002', order_no: null });

    await (await w.as('admin')).post('/api/items').send({ sku: 'KNEE-PAD', name: 'Knee pads', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 2499 }).expect(201);
    expect((await sales.post('/api/sales/online/retry').send({}).expect(200)).body.data).toEqual({ processed: 1, failed: 0 });
    const o = await orderBy('shopify', '5002');
    // Same state as the company: CGST and SGST. No shipping was charged, so there is no shipping line.
    expect(o).toMatchObject({ status: 'confirmed', place_of_supply: '27', party_name: 'Vikram Shah' });
    const detail = (await sales.get(`/api/sales/orders/${o.id}`).expect(200)).body.data;
    expect(detail.lines).toHaveLength(1);
    expect(detail.totals).toMatchObject({ grand_total: '2499.00', igst_total: '0.00' });
    expect(Number(detail.totals.cgst_total)).toBeGreaterThan(0);
  });

  it('knows a returning customer by phone, and credits the sale to where their enquiry came from', async () => {
    const parties = await count('parties');
    await fromShopifyStore('orders/create', shopifyOrder({ id: 5003, name: '#1003', customer: { first_name: 'A', last_name: 'Rao', phone: '9820011111' } })).expect(200);
    expect(await count('parties')).toBe(parties); // Asha is not added a second time
    expect((await orderBy('shopify', '5003')).party_name).toBe('Asha Rao');

    // Someone who enquired through an ad last week now buys on the website.
    const marketing = await w.as('marketing');
    const lead = await marketing.post('/api/leads').send({ name: 'Neha K', phone: '9820033333', source_id: m.source('Meta Ads') }).expect(201);
    await fromShopifyStore('orders/create', shopifyOrder({
      id: 5004, name: '#1004', customer: { first_name: 'Neha', last_name: 'Kulkarni', phone: '9820033333' }, email: 'neha@example.com',
      shipping_address: { name: 'Neha Kulkarni', phone: '9820033333', city: 'Mumbai', province_code: 'MH', zip: '400001' },
    })).expect(200);
    const o = await orderBy('shopify', '5004');
    expect(o.party_lead).toBe(lead.body.data.lead?.id ?? lead.body.data.id);
    expect(o.lead_id).toBe(o.party_lead);
  });

  it('flags an order whose total here differs from the total on Shopify', async () => {
    await fromShopifyStore('orders/create', shopifyOrder({ id: 5005, name: '#1005', total_price: '5899.00' })).expect(200);
    const e = await eventFor('shopify', 'order', '5005');
    expect(e.status).toBe('processed');
    expect(e.summary).toMatch(/₹5,999\.00 · SO.* · Shopify says ₹5,899\.00: check the prices and GST rates$/);
  });

  it('cancels the order here when the customer cancels on Shopify, unless the goods have already gone', async () => {
    const o = await orderBy('shopify', '5003');
    await fromShopifyStore('orders/cancelled', shopifyOrder({ id: 5003, name: '#1003', cancelled_at: '2026-10-12T10:00:00+05:30' })).expect(200);
    expect((await orderBy('shopify', '5003')).status).toBe('cancelled');
    expect(await eventFor('shopify', 'cancelled', '5003')).toMatchObject({ status: 'processed', order_id: o.id });

    // #1001 was delivered and invoiced above: that one needs a person.
    await fromShopifyStore('orders/cancelled', shopifyOrder({ cancelled_at: '2026-10-12T10:00:00+05:30' })).expect(200);
    const late = await eventFor('shopify', 'cancelled', '5001');
    expect(late.status).toBe('failed');
    expect(late.error).toMatch(/was cancelled by the customer, but SO.* has already been invoiced here\. Take the goods back with a credit note, then ignore this\./);
    expect((await orderBy('shopify', '5001')).status).toBe('invoiced');
    const sales = await w.as('sales');
    await sales.post(`/api/sales/online/events/${late.id}/ignore`).send({}).expect(200);
    await sales.post(`/api/sales/online/events/${(await eventFor('shopify', 'order', '5001')).id}/ignore`).send({}).expect(409);

    // Cancelled before it ever got in: the stuck order stops asking for attention.
    await fromShopifyStore('orders/create', shopifyOrder({ id: 5006, name: '#1006', line_items: [{ sku: 'NO-SUCH', title: 'Mystery', quantity: 1, price: '10.00' }] })).expect(200);
    await fromShopifyStore('orders/cancelled', shopifyOrder({ id: 5006, name: '#1006' })).expect(200);
    expect((await eventFor('shopify', 'order', '5006')).status).toBe('ignored');
    expect((await eventFor('shopify', 'cancelled', '5006')).summary).toBe('Shopify #1006 · cancelled before it was taken in');
  });
});

describe('Amazon and Flipkart order reports', () => {
  const amazon = [
    'amazon-order-id\tpurchase-date\torder-status\tsku\tproduct-name\tquantity\titem-price\tshipping-price\tship-city\tship-state\tship-postal-code\trecipient-name',
    '402-1111111-0000001\t2026-10-10T09:45:00+00:00\tShipped\tBRD-CRUISER\tCruiser Board\t2\t11800.00\t0\tPune\tMAHARASHTRA\t411001\tRohit K',
    '402-1111111-0000001\t2026-10-10T09:45:00+00:00\tShipped\tHLM-01\tHelmet\t1\t1534.00\t60.00\tPune\tMAHARASHTRA\t411001\tRohit K',
    '402-3333333-0000003\t2026-10-11T09:00:00+00:00\tPending\tHLM-01\tHelmet\t1\t1534.00\t0\tChennai\tTamil Nadu\t600001\tLakshmi',
    '402-4444444-0000004\t2026-10-11T09:00:00+00:00\tPending\tGHOST-1\tNot in our list\t1\t500.00\t0\tChennai\tTamil Nadu\t600001\tLakshmi',
    '402-2222222-0000002\t2026-10-11T03:00:00+00:00\tCancelled\tHLM-01\tHelmet\t1\t1534.00\t0\tDelhi\tDELHI\t110001\tSomeone',
  ].join('\n');

  it('takes each order in the file in once, under the marketplace as the one who pays', async () => {
    const sales = await w.as('sales');
    const first = (await sales.post('/api/sales/online/import').send({ channel: 'amazon', file: amazon }).expect(201)).body.data;
    expect(first).toEqual({ orders: 3, taken_in: 2, could_not: 1, already_here: 0, left_out: 1 });

    const o = await orderBy('amazon', '402-1111111-0000001');
    expect(o).toMatchObject({ status: 'confirmed', order_date: '2026-10-10', place_of_supply: '27', party_name: 'Amazon marketplace', party_phone: null });
    expect(o.notes).toBe('Amazon 402-1111111-0000001. Paid to Amazon, which settles with us. Ship to: Rohit K, Pune, MAHARASHTRA, 411001');
    const detail = (await sales.get(`/api/sales/orders/${o.id}`).expect(200)).body.data;
    expect(detail.lines.map((l: any) => [l.sku, Number(l.qty), l.rate])).toEqual([['BRD-CRUISER', 2, '5900.00'], ['HLM-01', 1, '1534.00'], ['SHIPPING', 1, '60.00']]);
    expect(detail.totals.grand_total).toBe('13394.00');
    // Tamil Nadu is another state, the same buyer-facing party: tax follows where the goods go.
    const tn = await orderBy('amazon', '402-3333333-0000003');
    expect(tn).toMatchObject({ place_of_supply: '33', party_id: o.party_id });

    // The same file again (people download overlapping reports): nothing is doubled, the stuck one stays stuck.
    const again = (await sales.post('/api/sales/online/import').send({ channel: 'amazon', file: amazon }).expect(201)).body.data;
    expect(again).toEqual({ orders: 3, taken_in: 0, could_not: 0, already_here: 3, left_out: 1 });
    expect((await rows(w.db, sql`select 1 from sales_orders where channel = 'amazon'`))).toHaveLength(2);
    expect((await eventFor('amazon', 'order', '402-4444444-0000004')).error).toMatch(/no item here has the SKU GHOST-1/);
  });

  it('takes a Flipkart report the same way, and refuses a file that is not an order report', async () => {
    const sales = await w.as('sales');
    const file = 'Order Id,Ordered On,SKU,Product,Quantity,Selling Price Per Item,Shipping Charge,Buyer Name,City,State,PIN Code,Order Item Status\r\n'
      + 'OD429000000000001,11-10-2026,HLM-01,"Helmet, black",3,"1,534.00",0,Meera,Kochi,Kerala,682001,APPROVED\r\n';
    expect((await sales.post('/api/sales/online/import').send({ channel: 'flipkart', file }).expect(201)).body.data).toMatchObject({ orders: 1, taken_in: 1 });
    const o = await orderBy('flipkart', 'OD429000000000001');
    expect(o).toMatchObject({ status: 'confirmed', order_date: '2026-10-11', place_of_supply: '32', party_name: 'Flipkart marketplace' });

    const wrong = await sales.post('/api/sales/online/import').send({ channel: 'flipkart', file: 'Date,Narration,Debit\n01-10-2026,UPI,100\n' }).expect(400);
    expect(wrong.body.error.message).toMatch(/does not look like a Flipkart order report/);
    const empty = await sales.post('/api/sales/online/import').send({ channel: 'amazon', file: 'order-id,sku,quantity,item-price,order-status\nA9,HLM-01,1,10,Cancelled\n' }).expect(400);
    expect(empty.body.error.message).toBe('No orders were found in the file (1 cancelled or returned rows were left out).');
  });

  it('is for the people who handle sales, and stays off the lead sources screen', async () => {
    await (await w.as('stores')).post('/api/sales/online/import').send({ channel: 'amazon', file: amazon }).expect(403);
    await (await w.as('hr')).get('/api/sales/online').expect(403);
    const screen = (await (await w.as('accounts')).get('/api/sales/online').expect(200)).body.data;
    expect(screen.by_channel.map((c: any) => c.channel).sort()).toEqual(['amazon', 'flipkart', 'shopify']);
    const crm = (await (await w.as('marketing')).get('/api/crm/integrations').expect(200)).body.data;
    expect(crm.events.filter((e: any) => ['shopify', 'amazon', 'flipkart'].includes(e.channel))).toHaveLength(0);
    await expectBooksHealthy(w);
  });
});
