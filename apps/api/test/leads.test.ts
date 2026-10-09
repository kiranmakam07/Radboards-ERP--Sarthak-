import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { captcha, captureLead } from '../src/modules/leads';
import type { DB } from '../src/db/client';
import { rows, sql } from '../src/db/client';
import { PASSWORD, masters, phoneOf, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let itemId: string;

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const item = await admin.post('/api/items').send({
    sku: 'sk8-01', name: 'Cruiser Board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18,
    retail_price: 5900, dealer_price: 4000, purchase_cost: 2500,
  }).expect(201);
  itemId = item.body.data.id;
});
afterAll(() => w.close());

describe('auth and roles', () => {
  it('rejects a wrong password and unauthenticated calls', async () => {
    await request(w.app).post('/api/auth/login').send({ identifier: phoneOf('sales'), password: 'nope' }).expect(401);
    await request(w.app).get('/api/leads').expect(401);
  });

  it('sets an HttpOnly session cookie and never returns the password hash', async () => {
    const res = await request(w.app).post('/api/auth/login').send({ identifier: '90000 00003', password: PASSWORD }).expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('rc_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(JSON.stringify(res.body)).not.toContain('password');
    const admin = await w.as('admin');
    const list = await admin.get('/api/users').expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password_hash/);
  });

  it('enforces least privilege', async () => {
    const store = await w.as('store');
    await store.get('/api/accounting/reports/trial-balance').expect(403);
    await store.post('/api/users').send({}).expect(403);
    await store.get('/api/payments').expect(403);
    const marketing = await w.as('marketing');
    await marketing.post('/api/sales/quick-bill').send({}).expect(403);
    await marketing.get('/api/dashboards/marketing').expect(200);
    await marketing.get('/api/dashboards/accounts').expect(403);
  });

  it('blocks cross-site state-changing requests', async () => {
    const sales = await w.as('sales');
    await sales.post('/api/leads').set('Origin', 'https://evil.example').send({}).expect(403);
  });

  it('signs a user out everywhere when deactivated', async () => {
    const admin = await w.as('admin');
    const created = await admin.post('/api/users').send({ name: 'Temp', phone: '9811111111', role: 'sales', password: 'Temp-pass-123' }).expect(201);
    const temp = request.agent(w.app);
    await temp.post('/api/auth/login').send({ identifier: '9811111111', password: 'Temp-pass-123' }).expect(200);
    await temp.get('/api/auth/me').expect(200);
    await admin.patch(`/api/users/${created.body.data.id}`).send({ active: false }).expect(200);
    await temp.get('/api/auth/me').expect(401);
  });
});

describe('lead capture', () => {
  it('captures a lead with an owner and a first follow-up date', async () => {
    const sales = await w.as('sales');
    const res = await sales.post('/api/leads').send({
      name: 'Asha Rao', phone: '98200 11111', source_id: m.source('Meta Ads'), source_detail: 'Diwali campaign', interested_item_ids: [itemId],
    }).expect(201);
    const lead = res.body.data;
    expect(lead.lead_no).toMatch(/^L\d+$/);
    expect(lead.phone).toBe('+919820011111');
    expect(lead.stage).toBe('new');
    expect(lead.owner_id).toBeTruthy();
    expect(lead.next_follow_up_at).toBeTruthy();
  });

  it('dedupes on phone: a repeat enquiry becomes an activity, not a second lead', async () => {
    const sales = await w.as('sales');
    const again = await sales.post('/api/leads').send({ name: 'Asha R', phone: '+91-9820011111', source_id: m.source('Google Ads') }).expect(200);
    expect(again.body.duplicate).toBe(true);
    const [count] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads where phone = '+919820011111'`);
    expect(count!.n).toBe(1);
    const detail = await sales.get(`/api/leads/${again.body.data.id}`).expect(200);
    expect(detail.body.data.activities.filter((a: { type: string }) => a.type === 'enquiry')).toHaveLength(2);
  });

  it('rejects an invalid phone number', async () => {
    const sales = await w.as('sales');
    const res = await sales.post('/api/leads').send({ name: 'Bad', phone: '12345', source_id: m.source('Other') }).expect(400);
    expect(res.body.error.message).toMatch(/mobile/);
  });

  it('is idempotent on external_ref, so a webhook retry cannot create a duplicate', async () => {
    const input = { name: 'Webhook Lead', phone: '+919820022222', sourceId: m.source('Meta Ads'), externalRef: 'meta:lead:777' };
    const first = await w.db.transaction((tx) => captureLead({ tx: tx as unknown as DB, user: null }, input));
    const second = await w.db.transaction((tx) => captureLead({ tx: tx as unknown as DB, user: null }, input));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
  });

  it('assigns web/ad leads round-robin across salespeople', async () => {
    const admin = await w.as('admin');
    await admin.post('/api/users').send({ name: 'Second Sales', phone: '9822222222', role: 'sales', password: 'Second-pass-1' }).expect(201);
    const owners = [];
    for (const phone of ['+919830000001', '+919830000002', '+919830000003', '+919830000004']) {
      const r = await w.db.transaction((tx) => captureLead({ tx: tx as unknown as DB, user: null }, { name: 'RR', phone, sourceId: m.source('Website') }));
      owners.push(r.lead.ownerId);
    }
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
  });

  it('takes public enquiries through a campaign link without login', async () => {
    const marketing = await w.as('marketing');
    const campaign = await marketing.post('/api/masters/campaigns').send({ name: 'Skate park pamphlets', source_id: m.source('Offline Campaign') }).expect(201);
    const token = campaign.body.data.token;
    await request(w.app).get(`/api/public/campaign/${token}`).expect(200);
    await request(w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Public Person', phone: '9840000001', message: 'Call me' }).expect(201);
    // The honeypot field catches bots.
    await request(w.app).post(`/api/public/enquiry/${token}`).send({ name: 'Bot', phone: '9840000002', website: 'http://spam' }).expect(400);
    await request(w.app).post('/api/public/enquiry/not-a-token').send({ name: 'X', phone: '9840000003' }).expect(404);
    const [lead] = await rows<{ source_detail: string; owner_id: string | null }>(w.db, sql`select source_detail, owner_id from leads where phone = '+919840000001'`);
    expect(lead!.source_detail).toBe('Skate park pamphlets');
    expect(lead!.owner_id).toBeTruthy();
  });

  it('can ask the public form for an "I am a person" check, once its keys are set', async () => {
    const marketing = await w.as('marketing');
    const token = (await marketing.post('/api/masters/campaigns').send({ name: 'Website banner', source_id: m.source('Website') }).expect(201)).body.data.token;
    // No keys: no check, and the form says so by sending no site key.
    expect((await request(w.app).get(`/api/public/campaign/${token}`).expect(200)).body.data.captcha_site_key).toBeNull();

    const real = captcha.verify;
    const asked: string[] = [];
    captcha.verify = async (answer) => { asked.push(answer); return answer === 'a-real-person'; };
    Object.assign(config, { turnstileSiteKey: 'site-key-123', turnstileSecret: 'secret-456' });
    try {
      expect((await request(w.app).get(`/api/public/campaign/${token}`).expect(200)).body.data.captcha_site_key).toBe('site-key-123');
      const body = { name: 'Checked Person', phone: '9840000009' };
      const none = await request(w.app).post(`/api/public/enquiry/${token}`).send(body).expect(400);
      expect(none.body.error.message).toContain('I am a person');
      await request(w.app).post(`/api/public/enquiry/${token}`).send({ ...body, captcha_token: 'a-bot' }).expect(400);
      const [before] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads where phone = '+919840000009'`);
      expect(before!.n).toBe(0);
      await request(w.app).post(`/api/public/enquiry/${token}`).send({ ...body, captcha_token: 'a-real-person' }).expect(201);
      expect(asked).toEqual(['a-bot', 'a-real-person']); // a missing answer is refused without asking Cloudflare
      const [after] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads where phone = '+919840000009'`);
      expect(after!.n).toBe(1);
    } finally {
      captcha.verify = real;
      Object.assign(config, { turnstileSiteKey: '', turnstileSecret: '' });
    }
  });
});

describe('lead pipeline (fixed stage machine)', () => {
  let lead_id: string;
  beforeAll(async () => {
    const sales = await w.as('sales');
    const res = await sales.post('/api/leads').send({ name: 'Pipeline Person', phone: '9850000001', source_id: m.source('Instagram Collab') }).expect(201);
    lead_id = res.body.data.id;
  });

  it('moves through stages and logs every change', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'contacted' }).expect(200);
    const r = await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'interested', note: 'Quote shared' }).expect(200);
    expect(r.body.data.first_contacted_at).toBeTruthy();
    const detail = await sales.get(`/api/leads/${lead_id}`).expect(200);
    expect(detail.body.data.activities.filter((a: { type: string }) => a.type === 'stage_change')).toHaveLength(2);
  });

  it('refuses an illegal transition and plain "converted"', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'new' }).expect(409);
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'converted' }).expect(400);
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'banana' }).expect(400);
  });

  it('requires a lost reason, and lets a lost lead reopen to Contacted only', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'lost' }).expect(400);
    const lost = await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'lost', lost_reason_id: m.lostReason('Price') }).expect(200);
    expect(lost.body.data.next_follow_up_at).toBeNull();
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'interested' }).expect(409);
    // Reopening needs a follow-up date, because Contacted requires one.
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'contacted' }).expect(400);
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'contacted', next_follow_up_at: new Date(Date.now() - 3600_000).toISOString() }).expect(200);
  });

  it('answers "whose follow-up is overdue?" and "lost by reason" as saved views', async () => {
    const sales = await w.as('sales');
    const overdue = await sales.get('/api/leads?view=overdue').expect(200);
    expect(overdue.body.data.map((l: { id: string }) => l.id)).toContain(lead_id);
    // Timestamps go out as ISO-8601, whichever query produced them.
    expect(overdue.body.data[0].next_follow_up_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const csv = await sales.get('/api/leads?view=open&format=csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('lead_no');
  });

  it('converts to a party in one click, links both ways, and is terminal', async () => {
    const sales = await w.as('sales');
    const res = await sales.post(`/api/leads/${lead_id}/convert`).send({ party_type: 'customer' }).expect(200);
    const { lead, party } = res.body.data;
    expect(lead.stage).toBe('converted');
    expect(lead.party_id).toBe(party.id);
    expect(party.lead_id).toBe(lead_id);
    expect(party.phone).toBe('+919850000001');
    expect(party.state_code).toBe('27');
    await sales.post(`/api/leads/${lead_id}/stage`).send({ stage: 'contacted', next_follow_up_at: new Date().toISOString() }).expect(409);
    // Converting again returns the same party rather than making another.
    const again = await sales.post(`/api/leads/${lead_id}/convert`).send({}).expect(200);
    expect(again.body.data.party.id).toBe(party.id);
  });
});

describe('walk-in capture', () => {
  it('records an enquiry in one call, stamped with source and who attended', async () => {
    const store = await w.as('store');
    const res = await store.post('/api/leads/walk-in').send({ phone: '9860000001', name: 'Walk In One', interested_item_ids: [itemId], outcome: 'enquiry' }).expect(201);
    const lead = res.body.data.lead;
    expect(lead.stage).toBe('new');
    expect(lead.attended_by).toBeTruthy();
    expect(res.body.data.party).toBeNull();
    const detail = await store.get(`/api/leads/${lead.id}`).expect(200);
    expect(detail.body.data.source_name).toBe('Walk-in');
  });

  it('"buying now" goes straight from New to Converted and returns the party for billing', async () => {
    const store = await w.as('store');
    const res = await store.post('/api/leads/walk-in').send({ phone: '9860000002', name: 'Walk In Buyer', outcome: 'buying_now' }).expect(201);
    expect(res.body.data.lead.stage).toBe('converted');
    expect(res.body.data.party.party_type).toBe('customer');
  });

  it('recognises a repeat customer by phone', async () => {
    const store = await w.as('store');
    const res = await store.get('/api/leads/lookup').query({ phone: '98600 00002' }).expect(200);
    expect(res.body.data.parties).toHaveLength(1);
    expect(res.body.data.parties[0].name).toBe('Walk In Buyer');
    expect(res.body.data.leads).toHaveLength(1);
  });
});

describe('the permission matrix can be changed by an admin', () => {
  const put = async (key: string, roles: string[], status: number) =>
    (await w.as('admin')).put(`/api/settings/permissions/${key}`).send({ roles }).expect(status);

  it('gives a role something new, takes something away, and goes back to the default', async () => {
    const accounts = await w.as('accounts');
    const marketing = await w.as('marketing');
    await accounts.get('/api/hr/employees').expect(403);
    await marketing.get('/api/leads').expect(200);

    // Let Accounts see HR (for salaries), and take the lead list away from Marketing.
    await put('hr:read', ['owner', 'hr', 'accounts'], 200);
    await put('leads:read', ['owner', 'store', 'sales'], 200);
    await accounts.get('/api/hr/employees').expect(200);
    await marketing.get('/api/leads').expect(403);
    expect((await accounts.get('/api/auth/me').expect(200)).body.permissions).toContain('hr:read');
    expect((await marketing.get('/api/auth/me').expect(200)).body.permissions).not.toContain('leads:read');

    const matrix = (await (await w.as('admin')).get('/api/settings/permissions').expect(200)).body;
    const row = (key: string) => matrix.data.find((p: { key: string }) => p.key === key);
    expect(row('hr:read')).toMatchObject({ roles: ['owner', 'hr', 'accounts'], default_roles: ['owner', 'hr', 'admin'], changed: true });
    expect(row('items:read').changed).toBe(false);

    // Setting it back to the built-in roles removes the change altogether.
    await put('hr:read', ['owner', 'hr'], 200);
    await put('leads:read', ['owner', 'marketing', 'store', 'sales'], 200);
    await accounts.get('/api/hr/employees').expect(403);
    await marketing.get('/api/leads').expect(200);
    const [saved] = await rows<{ value: Record<string, string[]> }>(w.db, sql`select value from settings where key = 'permission_overrides'`);
    expect(saved!.value).toEqual({});
  });

  it('is for admins only, and an admin can never be shut out', async () => {
    const owner = await w.as('owner');
    await owner.get('/api/settings/permissions').expect(403);
    await owner.put('/api/settings/permissions/leads:read').send({ roles: ['owner'] }).expect(403);
    await put('no:such', ['owner'], 404);
    await put('leads:read', ['janitor'], 400);

    // Even with every role removed from user management, the admin still gets in.
    await put('users:manage', [], 200);
    await (await w.as('admin')).get('/api/users').expect(200);
    await put('users:manage', [], 200);
    const log = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from audit_log where entity = 'permission'`);
    expect(log[0]!.n).toBeGreaterThanOrEqual(6);
  });
});
