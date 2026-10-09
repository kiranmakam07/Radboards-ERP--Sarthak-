import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@radcore/shared';
import { rows, sql } from '../src/db/client';
import { PASSWORD, REAL_POSTGRES, expectBooksHealthy, masters, onHand, openingStock, phoneOf, setup, type World } from './helpers';

/**
 * What happens when several people press Save at the same instant. These need a real
 * PostgreSQL server with real connections (the in-memory test database has only one), so
 * they run when TEST_DATABASE_URL is set - CI does this on every push.
 */
describe.skipIf(!REAL_POSTGRES)('simultaneous requests (real PostgreSQL)', () => {
  let w: World;
  let m: Awaited<ReturnType<typeof masters>>;
  let server: Server;
  let base: string;
  const cookies = new Map<Role, string>();
  const id: Record<string, string> = {};

  const cookieFor = async (role: Role) => {
    const cached = cookies.get(role);
    if (cached) return cached;
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: phoneOf(role), password: PASSWORD }),
    });
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    cookies.set(role, cookie);
    return cookie;
  };
  const call = async (role: Role, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', cookie: await cookieFor(role) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const atOnce = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
  const count = (results: { status: number }[], status: number) => results.filter((r) => r.status === status).length;
  const invoiceSeq = (no: string) => Number(no.split('/').pop());

  beforeAll(async () => {
    w = await setup();
    m = await masters(w.db);
    server = w.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = await w.as('admin');
    const item = async (sku: string) =>
      (await admin.post('/api/items').send({ sku, name: `Item ${sku}`, item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 1180, dealer_price: 900, purchase_cost: 500 }).expect(201)).body.data.id as string;
    id.plenty = await item('PLENTY');
    id.scarce = await item('SCARCE');
    id.credit = await item('CREDIT');
    await openingStock(w, m.showroom, [
      { item_id: id.plenty!, qty_change: '30', unit_cost: '500' },
      { item_id: id.scarce!, qty_change: '5', unit_cost: '500' },
      { item_id: id.credit!, qty_change: '10', unit_cost: '500' },
    ]);
    for (const role of ['store', 'sales', 'accounts', 'admin', 'owner'] as Role[]) await cookieFor(role);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await w.close();
  });

  it('20 bills saved at once get 20 consecutive invoice numbers, no gaps and no repeats', async () => {
    const results = await atOnce(20, () =>
      call('store', 'POST', '/api/sales/quick-bill', { lines: [{ item_id: id.plenty, qty: 1 }], payments: [{ mode: 'cash', amount: 1180 }] }));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const numbers = results.map((r) => invoiceSeq(r.body.data.invoice.invoice_no)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await onHand(w.db, id.plenty!, m.showroom)).toBe(10);
    // Every other document series stayed gap-free too.
    const series = await rows<{ doc_type: string; next_value: number; used: number }>(w.db, sql`
      select s.doc_type, s.next_value,
             case s.doc_type when 'sales_order' then (select count(*) from sales_orders)
                             when 'delivery' then (select count(*) from deliveries)
                             when 'receipt' then (select count(*) from payments where direction = 'in') end::int as used
        from number_series s where s.doc_type in ('sales_order', 'delivery', 'receipt')`);
    for (const s of series) expect(s.next_value - 1, s.doc_type).toBe(s.used);
    await expectBooksHealthy(w);
  });

  it('12 people selling the last 5 units: exactly 5 succeed and stock never goes negative', async () => {
    const results = await atOnce(12, () =>
      call('store', 'POST', '/api/sales/quick-bill', { lines: [{ item_id: id.scarce, qty: 1 }], payments: [{ mode: 'upi', amount: 1180 }] }));
    expect(count(results, 201)).toBe(5);
    expect(count(results, 409)).toBe(7);
    expect(await onHand(w.db, id.scarce!, m.showroom)).toBe(0);
    // The 7 refused bills did not use up invoice numbers: the 5 that went through follow straight on from 20.
    const numbers = results.filter((r) => r.status === 201).map((r) => invoiceSeq(r.body.data.invoice.invoice_no)).sort((a, b) => a - b);
    expect(numbers).toEqual([21, 22, 23, 24, 25]);
    const [lowest] = await rows<{ q: string }>(w.db, sql`
      select min(running)::text as q from (select sum(qty) over (partition by item_id, location_id order by id) as running from stock_movements) x`);
    expect(Number(lowest!.q)).toBeGreaterThanOrEqual(0);
    await expectBooksHealthy(w);
  });

  it('the same enquiry submitted 10 times at once becomes one lead', async () => {
    const results = await atOnce(10, () =>
      call('sales', 'POST', '/api/leads', { name: 'Double Tap', phone: '9876500001', source_id: m.source('Website') }));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(count(results, 201)).toBe(1);
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads where phone = '+919876500001'`);
    expect(n!.n).toBe(1);
  });

  it('a walk-in "buying now" double-tapped on the tablet makes one lead and one party', async () => {
    const results = await atOnce(6, () =>
      call('store', 'POST', '/api/leads/walk-in', { phone: '9876500002', name: 'Tablet Tapper', outcome: 'buying_now' }));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const [n] = await rows<{ leads: number; parties: number }>(w.db, sql`
      select (select count(*) from leads where phone = '+919876500002')::int as leads,
             (select count(*) from parties where phone = '+919876500002')::int as parties`);
    expect(n).toEqual({ leads: 1, parties: 1 });
    expect(new Set(results.map((r) => r.body.data.party.id)).size).toBe(1);
  });

  it('two tills billing the same brand-new customer at once share one party', async () => {
    const results = await atOnce(4, () =>
      call('store', 'POST', '/api/sales/quick-bill', {
        customer: { phone: '9876500003', name: 'New Customer' }, lines: [{ item_id: id.plenty, qty: 1 }], payments: [{ mode: 'cash', amount: 1180 }],
      }));
    expect(results.map((r) => r.status)).toEqual(Array(4).fill(201));
    const [n] = await rows<{ leads: number; parties: number }>(w.db, sql`
      select (select count(*) from leads where phone = '+919876500003')::int as leads,
             (select count(*) from parties where phone = '+919876500003')::int as parties`);
    expect(n).toEqual({ leads: 1, parties: 1 });
    expect(new Set(results.map((r) => r.body.data.invoice.party_id)).size).toBe(1);
  });

  it('five receipts racing to settle one invoice: the invoice is paid exactly once', async () => {
    const party = (await call('accounts', 'POST', '/api/parties', { party_type: 'customer', name: 'On Credit', phone: '9876500004' })).body.data;
    const bill = await call('store', 'POST', '/api/sales/quick-bill', { party_id: party.id, lines: [{ item_id: id.credit, qty: 2 }], payments: [] });
    expect(bill.status).toBe(201);
    expect(bill.body.data.balance_due).toBe('2360.00');
    const invoiceId = bill.body.data.invoice.id;
    const results = await atOnce(5, () =>
      call('accounts', 'POST', '/api/payments', {
        direction: 'in', party_id: party.id, mode: 'bank_transfer', amount: 2360, allocations: [{ invoice_id: invoiceId, amount: 2360 }],
      }));
    expect(count(results, 201)).toBe(1);
    expect(count(results, 409)).toBe(4);
    const doc = await call('accounts', 'GET', `/api/sales/invoices/${invoiceId}`);
    expect(doc.body.data.payment).toMatchObject({ payment_status: 'paid', outstanding: '0.00', allocated: '2360.00' });
    const balance = await call('accounts', 'GET', `/api/parties/${party.id}`);
    expect(Number(balance.body.data.balance)).toBe(0);
  });

  it('an adjustment approved by two people at once is applied once', async () => {
    const adj = await call('admin', 'POST', '/api/stock/adjustments', { location_id: m.showroom, reason: 'Damaged', lines: [{ item_id: id.credit, qty_change: -1 }] });
    expect(adj.status).toBe(201);
    const before = await onHand(w.db, id.credit!, m.showroom);
    const results = await Promise.all([
      call('admin', 'POST', `/api/stock/adjustments/${adj.body.data.id}/approve`, {}),
      call('owner', 'POST', `/api/stock/adjustments/${adj.body.data.id}/approve`, {}),
      call('admin', 'POST', `/api/stock/adjustments/${adj.body.data.id}/approve`, {}),
    ]);
    expect(count(results, 200)).toBe(1);
    expect(count(results, 409)).toBe(2);
    expect(await onHand(w.db, id.credit!, m.showroom)).toBe(before - 1);
    await expectBooksHealthy(w);
  });

  it('sales, a stock transfer and a credit sale all at once do not deadlock', async () => {
    await openingStock(w, m.stores, [{ item_id: id.plenty!, qty_change: '40', unit_cost: '500' }]);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => call('store', 'POST', '/api/sales/quick-bill', { lines: [{ item_id: id.plenty, qty: 1 }], payments: [{ mode: 'cash', amount: 1180 }] })),
      ...Array.from({ length: 4 }, () => call('admin', 'POST', '/api/stock/transfers', { from_location_id: m.stores, to_location_id: m.showroom, reason: 'Refill', lines: [{ item_id: id.plenty, qty: 5 }] })),
      ...Array.from({ length: 4 }, () => call('accounts', 'POST', '/api/accounting/expenses', { category_id: m.expenseCategory('Rent'), amount: 100, paid_from_account_id: m.account('cash') })),
    ]);
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    await expectBooksHealthy(w);
  });
});
