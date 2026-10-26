import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, addDays, can, istDate, type Role } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { COST_KEYS } from '../src/lib/http';
import { expectBooksHealthy, gstin, masters, openingStock, setup, type World } from './helpers';

/**
 * The four bugs found on the demo on 21 Oct 2026 (implementation brief, P0), each written so it
 * failed before the fix:
 *   1. a sales user could bill 3 boards costing ₹2,500 each at ₹1;
 *   2. the quick bill ignored the dealer's credit limit, and nothing stopped credit with bills overdue;
 *   3. sales and marketing were sent cost price (items, stock, invoices);
 *   (4, GST at 40% with cess, is in gst-cess.test.ts.)
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};
const TODAY = istDate();

const invoiceCount = async () => Number((await rows<{ n: string }>(w.db, sql`select count(*)::text as n from invoices`))[0]!.n);
const auditActions = async (action: string) =>
  rows<{ entity_id: string; after: any; user_id: string }>(w.db, sql`select entity_id, after, user_id from audit_log where action = ${action} order by id`);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  // Board: retail ₹5,900 with 18% GST (₹5,000 before GST), dealer ₹4,000 + GST, costs ₹2,500.
  const board = await admin.post('/api/items').send({
    sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
    retail_price: 5900, dealer_price: 4000, purchase_cost: 2500, barcode: '8900000000017',
  }).expect(201);
  id.board = board.body.data.id;
  await openingStock(w, m.showroom, [{ item_id: id.board!, qty_change: '100', unit_cost: '2500' }]);
  await openingStock(w, m.stores, [{ item_id: id.board!, qty_change: '100', unit_cost: '2500' }]);

  const dealer = await admin.post('/api/parties').send({
    party_type: 'dealer', name: 'Pune Boards', phone: '9700000002', gstin: gstin('27', 'DEALR1234B'), credit_limit: 50000, payment_terms_days: 15,
  }).expect(201);
  id.dealer = dealer.body.data.id;
  const late = await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Late Payer Boards', phone: '9700000003', payment_terms_days: 15 }).expect(201);
  id.late = late.body.data.id;
});
afterAll(() => w.close());

describe('1. selling below cost or over the discount limit', () => {
  it('refuses a sales user\'s quick bill at ₹1 a board, with a clear message, and saves nothing', async () => {
    const sales = await w.as('sales');
    const before = await invoiceCount();
    const res = await sales.post('/api/sales/quick-bill').send({
      customer: { phone: '9811111111', name: 'Walk In' }, lines: [{ item_id: id.board, qty: 3, rate: 1 }], payments: [{ mode: 'cash', amount: 3 }],
    }).expect(409);
    expect(res.body.error.message).toMatch(/Cruiser Board at ₹0\.85 before GST is below its cost/);
    expect(res.body.error.message).toMatch(/owner or Accounts must approve/);
    // The refusal names the item and the price, never what it cost us.
    expect(JSON.stringify(res.body)).not.toMatch(/2,?500/);
    expect(await invoiceCount()).toBe(before);
  });

  it('holds sales to 10% off the list and the counter to 5%', async () => {
    const sales = await w.as('sales');
    const store = await w.as('store');
    // 12% off ₹5,900 = ₹5,192: over the 10% limit.
    const over = await sales.post('/api/sales/quick-bill').send({
      lines: [{ item_id: id.board, qty: 1, rate: 5192 }], payments: [{ mode: 'cash', amount: 5192 }],
    }).expect(409);
    expect(over.body.error.message).toMatch(/12% below its list price of ₹5,000\.00; your limit is 10%/);
    // 8% off (₹5,428): fine for sales...
    await sales.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.board, qty: 1, rate: 5428 }], payments: [{ mode: 'cash', amount: 5428 }] }).expect(201);
    // ...but not for the counter, whose limit is 5%.
    const counter = await store.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.board, qty: 1, rate: 5428 }], payments: [{ mode: 'cash', amount: 5428 }] }).expect(409);
    expect(counter.body.error.message).toMatch(/your limit is 5%/);
  });

  it('lets the owner approve: a sales order below cost waits in draft until the owner confirms it', async () => {
    const sales = await w.as('sales');
    const owner = await w.as('owner');
    const order = await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.dealer, lines: [{ item_id: id.board, qty: 3, rate: 1 }] }).expect(201);
    id.cheap = order.body.data.id;
    const refused = await sales.post(`/api/sales/orders/${id.cheap}/confirm`).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/ask one of them to confirm this order/);

    // The order page tells the owner what needs approving.
    const seen = await owner.get(`/api/sales/orders/${id.cheap}`).expect(200);
    expect(seen.body.data.price_problems).toEqual([expect.objectContaining({ item: 'Cruiser Board', unit_price: '1.00', below_cost: true })]);
    expect(Object.keys(seen.body.data.price_problems[0])).not.toContain('cost');

    await owner.post(`/api/sales/orders/${id.cheap}/confirm`).send({}).expect(200);
    const logged = await auditActions('price_override');
    expect(logged.at(-1)).toMatchObject({ entity_id: id.cheap, after: { lines: [expect.objectContaining({ below_cost: true })] } });
  });

  it('lets Accounts bill below cost at the counter, and logs it', async () => {
    const accounts = await w.as('accounts');
    const before = (await auditActions('price_override')).length;
    await accounts.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.board, qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] }).expect(201);
    expect((await auditActions('price_override')).length).toBe(before + 1);
  });

  it('takes the limits from the settings', async () => {
    const admin = await w.as('admin');
    await admin.put('/api/settings/discount-limits').send({ discount_limits: { store: 5, sales: 15 } }).expect(200);
    const sales = await w.as('sales');
    await sales.post('/api/sales/quick-bill').send({ lines: [{ item_id: id.board, qty: 1, rate: 5192 }], payments: [{ mode: 'cash', amount: 5192 }] }).expect(201);
    await admin.put('/api/settings/discount-limits').send({ discount_limits: { store: 5, sales: 10 } }).expect(200);
    await (await w.as('marketing')).put('/api/settings/discount-limits').send({ discount_limits: {} }).expect(403);
  });
});

describe('2. the quick bill and the dealer\'s credit', () => {
  // 15 boards to a dealer: 15 x ₹4,000 = ₹60,000 + 18% = ₹70,800, against a ₹50,000 limit.
  const fifteen = [{ item_id: '', qty: 15 }];
  beforeAll(() => { fifteen[0]!.item_id = id.board!; });

  it('refuses a credit bill over the limit for sales', async () => {
    const sales = await w.as('sales');
    const res = await sales.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [] }).expect(409);
    // 70,800 for this bill, and 4 for the 3 boards at 1 confirmed above and not billed yet: orders on hand count too
    // (technical review, 26 Oct 2026).
    expect(res.body.error.message).toMatch(/Pune Boards would be at 70804\.00 against a credit limit of 50000\.00 \(₹4\.00 of it on orders not yet billed\)/);
    await sales.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [], override_credit: true }).expect(403);
  });

  it('checks only the unpaid part, and not at all when the bill is paid in full', async () => {
    const sales = await w.as('sales');
    // ₹30,000 paid now leaves ₹40,800 on credit: inside the limit.
    const part = await sales.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [{ mode: 'upi', amount: 30000 }] }).expect(201);
    expect(part.body.data.balance_due).toBe('40800.00');
    // They now owe ₹40,800, so a second one fully on credit is over; paid in full it goes through.
    await sales.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [] }).expect(409);
    await sales.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [{ mode: 'upi', amount: 70800 }] }).expect(201);
  });

  it('allows it with an override by Accounts, and logs it', async () => {
    const accounts = await w.as('accounts');
    await accounts.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [] }).expect(409);
    await accounts.post('/api/sales/quick-bill').send({ party_id: id.dealer, lines: fifteen, payments: [], override_credit: true }).expect(201);
    expect((await auditActions('credit_limit_override')).length).toBe(1);
  });

  it('blocks more credit while a bill is past its due date, unless overridden', async () => {
    const sales = await w.as('sales');
    const accounts = await w.as('accounts');
    // A bill from 40 days ago on 15-day terms: due 25 days ago, and not paid.
    const old = await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.late, order_date: addDays(TODAY, -40), lines: [{ item_id: id.board, qty: 1 }] }).expect(201);
    await sales.post(`/api/sales/orders/${old.body.data.id}/confirm`).send({}).expect(200);
    await sales.post(`/api/sales/orders/${old.body.data.id}/deliver`).send({}).expect(201);
    await sales.post(`/api/sales/orders/${old.body.data.id}/invoice`).send({ invoice_date: addDays(TODAY, -40) }).expect(201);

    const quick = await sales.post('/api/sales/quick-bill').send({ party_id: id.late, lines: [{ item_id: id.board, qty: 1 }], payments: [] }).expect(409);
    expect(quick.body.error.message).toMatch(/Late Payer Boards has a bill past the due date \(₹4,720\.00/);
    const order = await sales.post('/api/sales/orders').send({ channel: 'dealer', party_id: id.late, lines: [{ item_id: id.board, qty: 1 }] }).expect(201);
    await sales.post(`/api/sales/orders/${order.body.data.id}/confirm`).send({}).expect(409);
    // Paid in full there is no credit to refuse.
    await sales.post('/api/sales/quick-bill').send({ party_id: id.late, lines: [{ item_id: id.board, qty: 1 }], payments: [{ mode: 'cash', amount: 4720 }] }).expect(201);
    // Accounts can let it through, and it is logged.
    await accounts.post(`/api/sales/orders/${order.body.data.id}/confirm`).send({ override_credit: true }).expect(200);
    expect((await auditActions('overdue_override')).at(-1)).toMatchObject({ entity_id: order.body.data.id, after: { overdue: '4720.00', bills: 1 } });
  });

  it('keeps the books balanced', async () => {
    await expectBooksHealthy(w);
  });
});

describe('3. cost price only for costs:read', () => {
  const COST = new Set<string>([...COST_KEYS]);
  /** Every key path in an answer that is a cost field. */
  const costPaths = (v: unknown, path = '', extra: Set<string> = new Set()): string[] => {
    if (Array.isArray(v)) return v.flatMap((x, i) => costPaths(x, `${path}[${i}]`, extra));
    if (v && typeof v === 'object') {
      return Object.entries(v).flatMap(([k, x]) => [
        ...(COST.has(k) || extra.has(k) ? [`${path}.${k}`] : []), ...costPaths(x, `${path}.${k}`, extra),
      ]);
    }
    return [];
  };

  let invoiceId = '';
  let deliveryId = '';
  let orderId = '';
  beforeAll(async () => {
    const [inv] = await rows<{ id: string; order_id: string }>(w.db, sql`select id, order_id from invoices where status = 'issued' order by created_at limit 1`);
    invoiceId = inv!.id; orderId = inv!.order_id;
    const [d] = await rows<{ id: string }>(w.db, sql`select id from deliveries where order_id = ${orderId}`);
    deliveryId = d!.id;
  });

  const reads = () => [
    { url: '/api/items', stock: false }, { url: `/api/items/${id.board}`, stock: false }, { url: '/api/items/lookup?code=BRD-1', stock: false },
    { url: '/api/stock/on-hand', stock: true }, { url: '/api/stock/movements', stock: true }, { url: '/api/stock/low', stock: true },
    { url: `/api/sales/orders/${orderId}`, stock: false }, { url: `/api/sales/invoices/${invoiceId}`, stock: false },
    { url: `/api/sales/deliveries/${deliveryId}`, stock: false },
  ];

  it.each(ROLES.map((r) => [r]))('%s sees cost fields only if it holds costs:read', async (role: Role) => {
    const agent = await w.as(role);
    const sees = can(role, 'costs:read');
    let checked = 0;
    for (const { url, stock } of reads()) {
      const res = await agent.get(url);
      if (res.status === 403) continue;
      expect(res.status, url).toBe(200);
      checked++;
      const found = costPaths(res.body, '', stock ? new Set(['value', 'total_value']) : new Set());
      if (!sees) expect(found, `${role} ${url}`).toEqual([]);
    }
    if (can(role, 'items:read')) {
      expect(checked).toBeGreaterThan(0);
      const list = await agent.get('/api/items').expect(200);
      expect('purchase_cost' in list.body.data[0]).toBe(sees);
      // The download is the same list, so it follows the same rule.
      const csv = await agent.get('/api/items?format=csv').expect(200);
      expect(csv.text.split('\r\n')[0]!.split(',').includes('purchase_cost')).toBe(sees);
    }
    const valuation = await agent.get('/api/stock/valuation');
    expect(valuation.status).toBe(sees ? 200 : 403);
  });

  it('as sales, GET /api/items has no cost field at all', async () => {
    const sales = await w.as('sales');
    const res = await sales.get('/api/items').expect(200);
    expect(costPaths(res.body)).toEqual([]);
    const item = await sales.get(`/api/items/${id.board}`).expect(200);
    expect(item.body.data.valuation).toBeUndefined();
    expect(item.body.data.movements[0]).not.toHaveProperty('unit_cost');
  });
});
