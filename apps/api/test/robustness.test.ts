import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, can, type Permission } from '@radcore/shared';
import { masters, setup, type World } from './helpers';

/**
 * Every route the API has, read from the code itself (the mounts in app.ts and the routes in each
 * router), so a route added later is covered without anyone remembering to add it here.
 *
 *   - nobody who is not signed in gets past a route that needs a sign-in
 *   - a role without the route's permission is refused, for every role and every route
 *   - nothing anyone can send makes a route fall over (no 500): malformed ids, wrong types, nonsense
 *     dates, huge text, empty and odd bodies, odd query strings
 */
type Route = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; perms: Permission[] | null; open: boolean };

function readRoutes(): Route[] {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const app = fs.readFileSync(path.join(src, 'app.ts'), 'utf8');
  const mounts = new Map<string, string[]>();
  for (const m of app.matchAll(/app\.use\('([^']+)'(?:,\s*\w+)*,\s*(\w+Router)\(/g)) {
    mounts.set(m[2]!, [...(mounts.get(m[2]!) ?? []), m[1]!]);
  }
  const out: Route[] = [];
  for (const file of fs.readdirSync(path.join(src, 'modules'))) {
    const text = fs.readFileSync(path.join(src, 'modules', file), 'utf8');
    const parts = text.split(/\nexport function (\w+Router)\(/);
    for (let i = 1; i < parts.length; i += 2) {
      for (const prefix of mounts.get(parts[i]!) ?? []) {
        for (const r of parts[i + 1]!.matchAll(/\b\w+\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(requirePerm\(([^)]*)\))?/g)) {
          const full = `${prefix}${r[2] === '/' ? '' : r[2]}`.replace(/\/$/, '') || '/';
          const perms = r[4] ? [...r[4].matchAll(/'([^']+)'/g)].map((x) => x[1] as Permission) : null;
          out.push({ method: r[1] as Route['method'], path: full, perms, open: /^\/api\/(public|hooks)\b/.test(full) });
        }
      }
    }
  }
  return out;
}

const ROUTES = readRoutes();
const ID = () => crypto.randomUUID();
/** A path with each :param filled in. */
const fill = (p: string, as: (name: string) => string) => p.replace(/:([A-Za-z_]+)/g, (_m, name: string) => as(name));

let w: World;
beforeAll(async () => { w = await setup(); });
afterAll(() => w.close());

describe('every route, read from the code', () => {
  it('finds the routes', () => {
    expect(ROUTES.length).toBeGreaterThan(300);
    expect(ROUTES.filter((r) => !r.open && !r.perms).map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['post /api/auth/logout']));
  });

  it('refuses everyone who is not signed in, on every route that needs a sign-in', async () => {
    const leaks: string[] = [];
    for (const r of ROUTES) {
      // Signing in, signing out (which always succeeds) and the health check are open by design.
      if (r.open || ['/api/auth/login', '/api/auth/logout', '/api/health'].includes(r.path)) continue;
      const res = await request(w.app)[r.method](fill(r.path, () => ID())).send({});
      if (res.status !== 401) leaks.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    if (leaks.length) console.log(`LEAKS:\n${leaks.join('\n')}`);
    expect(leaks).toEqual([]);
  });

  it('refuses every role that does not hold the permission a route names', async () => {
    const leaks: string[] = [];
    for (const role of ROLES) {
      if (role === 'admin') continue;
      const agent = await w.as(role);
      for (const r of ROUTES) {
        if (!r.perms || r.perms.some((p) => can(role, p))) continue;
        const res = await agent[r.method](fill(r.path, () => ID())).send({});
        if (res.status !== 403) leaks.push(`${role}: ${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
      }
    }
    if (leaks.length) console.log(`LEAKS:\n${leaks.join('\n')}`);
    expect(leaks).toEqual([]);
  });

  it('never falls over, whatever is sent', async () => {
    const admin = await w.as('admin');
    const junkBodies: unknown[] = [
      {},
      [],
      { lines: 'not a list', items: {}, allocations: [{}], entries: [{ employee_id: 'x' }] },
      {
        amount: -5, qty: 'abc', rate: 1e309, date: '2026-02-30', from: 'yesterday', to: '2026-13-01', month: '2026-13', paid_on: 'x',
        party_id: 'nope', item_id: ID(), account_id: ID(), supplier_id: 123, invoice_id: null, lines: [{ item_id: 'x', qty: -1 }],
        name: 'n'.repeat(5000), phone: '12', gstin: 'NOTAGSTIN', email: 'not-an-email', status: 'zzz', stage: 'banana', kind: '?',
        reason: '', notes: { a: 1 }, csv: 'a,b\n1', file: 42, approve: 'yes', active: 'maybe', percent: 900, steps: 'x',
      },
      { lines: [{ item_id: ID(), qty: '1e9', rate: '-1' }], party_id: ID(), supplier_id: ID(), employee_id: ID(), date: '1900-01-01' },
    ];
    const junkQuery = '?limit=-1&offset=abc&from=2026-02-30&to=nope&format=pdf&q=%27%3B--&month=13&status=zzz&as_of=x&kind=?&account_id=x&fy=bad&view=x&stage=x';
    const crashes: string[] = [];
    // 503 with a message is a deliberate answer ("not connected yet"), not a crash.
    const fell = (res: request.Response) => res.status >= 500 && !(res.status === 503 && res.body?.error?.message);
    for (const r of ROUTES) {
      if (r.open || r.path === '/api/auth/logout') continue;
      const paths = [fill(r.path, () => ID()), fill(r.path, (n) => (n === 'fy' ? '2019-20' : n === 'key' ? 'leads:read' : 'not-an-id'))];
      for (const p of paths) {
        if (r.method === 'get' || r.method === 'delete') {
          for (const q of ['', junkQuery]) {
            const res = await admin[r.method](p + q);
            if (fell(res)) crashes.push(`${r.method.toUpperCase()} ${p}${q ? ' + junk query' : ''} -> ${res.status} ${res.body?.error?.message ?? ''}`);
          }
        } else {
          for (const body of junkBodies) {
            const res = await admin[r.method](p).send(body as object);
            if (fell(res)) crashes.push(`${r.method.toUpperCase()} ${p} ${JSON.stringify(body).slice(0, 60)} -> ${res.status} ${res.body?.error?.message ?? ''}`);
          }
          // A body that is not JSON at all.
          const raw = await admin[r.method](p).set('Content-Type', 'application/json').send('{"broken": ');
          if (fell(raw)) crashes.push(`${r.method.toUpperCase()} ${p} broken JSON -> ${raw.status}`);
        }
      }
    }
    if (crashes.length) console.log(`ROUTES THAT FELL OVER:\n${crashes.join('\n')}`);
    expect(crashes).toEqual([]);
  });
});

describe('numbers too big to keep', () => {
  // Money columns hold up to 99,99,99,999.99 and quantities up to 99,99,99,999.999; a total worked out
  // from figures that are each within bounds can still go past that, and must be refused, not crash.
  it('refuses them with a plain answer', async () => {
    const admin = await w.as('admin');
    const m = await masters(w.db);
    const item = (await admin.post('/api/items').send({ sku: 'BIG-1', name: 'Big board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
      retail_price: '9999999999', dealer_price: '9999999999', purchase_cost: '9999999999' }).expect(201)).body.data.id as string;
    const party = (await admin.post('/api/parties').send({ party_type: 'dealer', name: 'Big Buyer' }).expect(201)).body.data.id as string;
    const supplier = (await admin.post('/api/parties').send({ party_type: 'supplier', name: 'Big Seller' }).expect(201)).body.data.id as string;
    const tries: [string, string, object][] = [
      ['post', '/api/stock/adjustments', { kind: 'opening', location_id: m.stores, reason: 'x', lines: [{ item_id: item, qty_change: '999999999999', unit_cost: '1' }] }],
      ['post', '/api/stock/adjustments', { kind: 'opening', location_id: m.stores, reason: 'x', lines: [{ item_id: item, qty_change: '999999', unit_cost: '9999999999' }] }],
      ['post', '/api/sales/orders', { channel: 'dealer', party_id: party, lines: [{ item_id: item, qty: '999999999999' }] }],
      ['post', '/api/sales/orders', { channel: 'dealer', party_id: party, lines: [{ item_id: item, qty: '1000' }] }],
      ['post', '/api/purchasing/orders', { supplier_id: supplier, lines: [{ item_id: item, qty: '1000', rate: '9999999999' }] }],
      ['post', '/api/purchasing/orders', { supplier_id: supplier, lines: [{ item_id: item, qty: '99999999999999', rate: '1' }] }],
    ];
    const fell: string[] = [];
    for (const [method, url, body] of tries) {
      const res = await (admin as any)[method](url).send(body);
      if (res.status >= 500) fell.push(`${url} ${JSON.stringify(body).slice(0, 90)} -> ${res.status}`);
      else expect(res.status, `${url} ${res.body?.error?.message}`).toBeLessThan(500);
    }
    if (fell.length) console.log(`ROUTES THAT FELL OVER:\n${fell.join('\n')}`);
    expect(fell).toEqual([]);
  });

  it('says a repeated code in plain words', async () => {
    const admin = await w.as('admin');
    const res = await admin.post('/api/items').send({ sku: 'BIG-1', name: 'Same code again', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18 }).expect(409);
    expect(res.body.error.message).not.toMatch(/Key \(|constraint/);
  });
});
