import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPermissionOverrides } from '@radcore/shared';
import { setSetting } from '../src/core/settings';
import { makeHandler } from '../src/serverless';
import { PASSWORD, phoneOf, setup, type World } from './helpers';

let w: World;
let server: http.Server;

/**
 * Stands in for the web framework the API sits behind on a per-request host: like Next.js, it
 * puts its own `query` and `cookies` on the request and its own `status` / `json` / `send` on the
 * response before handing them over. Every one of them is wrong on purpose, so a route that works
 * here is proven to be using Express's own.
 */
function behindAFramework(handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
  return http.createServer((req, res) => {
    const wrong = () => {
      throw new Error("the host framework's helper was used instead of Express's");
    };
    Object.assign(req, { query: { q: 'nothing-is-called-this', path: ['items'] }, cookies: {} });
    Object.assign(res, { status: wrong, json: wrong, send: wrong, redirect: wrong });
    void handle(req, res);
  });
}

beforeAll(async () => {
  w = await setup();
  server = behindAFramework(makeHandler(async () => ({ app: w.app, db: w.db }), 0));
});
afterAll(async () => {
  setPermissionOverrides({});
  server.close();
  await w.close();
});

describe('the API as a per-request handler', () => {
  it('signs in, keeps the session and reads the address the way the server does', async () => {
    const agent = request.agent(server);
    const login = await agent.post('/api/auth/login').send({ identifier: phoneOf('admin'), password: PASSWORD }).expect(200);
    expect(login.body.user.role).toBe('admin');
    expect(login.body.max_upload_mb).toBe(10);
    // The cookie comes back and is read by the API itself, not taken from the host's (empty) copy.
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.phone).toBe(phoneOf('admin'));

    await agent.post('/api/items').send({ sku: 'BRD-1', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: '18' }).expect(201);
    // The search word is read from the address, not from the host's copy of it.
    expect((await agent.get('/api/items?q=cruiser').expect(200)).body.data).toHaveLength(1);
    expect((await agent.get('/api/items?q=longboard').expect(200)).body.data).toHaveLength(0);
    await request(server).get('/api/items').expect(401);
    await request(server).get('/api/no-such-thing').expect(401);
    expect((await request(server).get('/api/health').expect(200)).body).toEqual({ ok: true });
  });

  it('picks up a permission change made through another running copy', async () => {
    const sales = request.agent(server);
    await sales.post('/api/auth/login').send({ identifier: phoneOf('sales'), password: PASSWORD }).expect(200);
    await sales.get('/api/stock/on-hand').expect(200);
    // Saved straight to the database, as if another copy of the API had handled the admin's change.
    await setSetting(w.db, 'permission_overrides', { 'stock:read': ['stores'] }, null);
    await sales.get('/api/stock/on-hand').expect(403);
    await setSetting(w.db, 'permission_overrides', {}, null);
    await sales.get('/api/stock/on-hand').expect(200);
  });

  it('says so plainly when it cannot start, and tries again on the next request', async () => {
    let attempts = 0;
    const broken = behindAFramework(makeHandler(async () => {
      attempts += 1;
      throw new Error('database is not there');
    }));
    try {
      const res = await request(broken).get('/api/auth/me').expect(503);
      expect(res.body.error.code).toBe('unavailable');
      expect(res.body.error.message).toMatch(/database/i);
      await request(broken).get('/api/auth/me').expect(503);
      expect(attempts).toBe(2);
    } finally {
      broken.close();
    }
  });
});
