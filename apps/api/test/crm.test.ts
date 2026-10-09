import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import { fromGoogleColumns, fromMetaFields, renderTemplate } from '../src/modules/crm';
import { masters, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let googleKey: string;
let websiteToken: string;
let itemId: string;

/** What Meta's Graph API would answer, by leadgen id. Tests fill this in; anything else is "not found". */
const graph = new Map<string, { status: number; body: unknown }>();
const asked: string[] = [];

const SECRET = 'test-app-secret';
const sign = (raw: string, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
/** Post a webhook exactly as Meta does: raw JSON bytes plus a signature over those bytes. */
const fromMeta = (path: string, body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return request(w.app).post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw, secret)).send(raw);
};
const leadCount = async () => (await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads`))[0]!.n;
const leadByPhone = async (phone: string) =>
  (await rows<Record<string, any>>(w.db, sql`
    select l.*, s.name as source_name, u.role::text as owner_role from leads l
      join lead_sources s on s.id = l.source_id left join users u on u.id = l.owner_id where l.phone = ${phone}`))[0];

beforeAll(async () => {
  w = await setup(async (url) => {
    asked.push(url);
    const id = new URL(url).pathname.split('/').pop()!;
    return graph.get(id) ?? { status: 404, body: { error: { message: 'Unsupported get request' } } };
  });
  m = await masters(w.db);
  const admin = await w.as('admin');
  const marketing = await w.as('marketing');
  googleKey = (await marketing.post('/api/masters/campaigns').send({ name: 'Google - longboard search', source_id: m.source('Google Ads') }).expect(201)).body.data.token;
  websiteToken = (await marketing.post('/api/masters/campaigns').send({ name: 'Website contact form', source_id: m.source('Website') }).expect(201)).body.data.token;
  itemId = (await admin.post('/api/items').send({ sku: 'LB-42', name: 'Longboard 42', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: 9440 }).expect(201)).body.data.id;
});
afterAll(async () => {
  Object.assign(config, { metaAppSecret: '', metaVerifyToken: '', metaPageAccessToken: '' });
  await w.close();
});

describe('Google Ads lead forms', () => {
  const lead = (id: string, phone: string, extra: object = {}) => ({
    lead_id: id, api_version: '1.0', form_id: 40000000000, campaign_id: 123456, gcl_id: 'TeSter-123', google_key: googleKey, is_test: false,
    user_column_data: [
      { column_name: 'Full Name', column_id: 'FULL_NAME', string_value: 'Vikram Shah' },
      { column_name: 'User Phone', column_id: 'PHONE_NUMBER', string_value: phone },
      { column_name: 'User Email', column_id: 'EMAIL', string_value: 'vikram@example.com' },
      { column_name: 'City', column_id: 'CITY', string_value: 'Pune' },
    ],
    ...extra,
  });

  it('refuses a request without our key, and creates nothing for Google\'s test lead', async () => {
    await request(w.app).post('/api/hooks/google-ads').send({ ...lead('g-0', '+919820022222'), google_key: 'guess' }).expect(403);
    await request(w.app).post('/api/hooks/google-ads').send({ lead_id: 'x' }).expect(400);
    const test = await request(w.app).post('/api/hooks/google-ads').send(lead('g-test', '+919820022222', { is_test: true })).expect(200);
    expect(test.body).toEqual({});
    expect(await leadCount()).toBe(0);
  });

  it('turns a submitted form into a lead with its campaign, an owner and a follow-up', async () => {
    const res = await request(w.app).post('/api/hooks/google-ads').send(lead('g-1', '+919820022222')).expect(200);
    expect(res.body).toEqual({});
    const l = await leadByPhone('+919820022222');
    expect(l).toMatchObject({
      name: 'Vikram Shah', email: 'vikram@example.com', source_name: 'Google Ads', source_detail: 'Google - longboard search',
      stage: 'new', external_ref: 'google:g-1', notes: 'City: Pune', owner_role: 'sales',
    });
    expect(l!.next_follow_up_at).toBeTruthy();
    expect(l!.campaign_id).toBeTruthy();
    // The key that proved the request is never stored with it.
    const [stored] = await rows<{ payload: unknown }>(w.db, sql`select payload from channel_events where external_id = 'g-1'`);
    expect(JSON.stringify(stored!.payload)).not.toContain(googleKey);
  });

  it('is not fooled by Google sending the same lead twice, or the same person enquiring again', async () => {
    await request(w.app).post('/api/hooks/google-ads').send(lead('g-1', '+919820022222')).expect(200);
    expect(await leadCount()).toBe(1);
    await request(w.app).post('/api/hooks/google-ads').send(lead('g-2', '98200 22222')).expect(200);
    expect(await leadCount()).toBe(1);
    const l = await leadByPhone('+919820022222');
    const notes = await rows<{ note: string }>(w.db, sql`select note from lead_activities where lead_id = ${l!.id} and type = 'enquiry'`);
    expect(notes.map((n) => n.note)).toContain('Repeat enquiry via Google Ads / Google - longboard search: City: Pune');
  });

  it('keeps what it could not use, with the reason, for a person to look at', async () => {
    const noPhone = lead('g-3', '');
    await request(w.app).post('/api/hooks/google-ads').send(noPhone).expect(200); // Google is told "received" either way
    expect(await leadCount()).toBe(1);
    const marketing = await w.as('marketing');
    const screen = (await marketing.get('/api/crm/integrations').expect(200)).body.data;
    const failed = screen.events.find((e: { status: string }) => e.status === 'failed');
    expect(failed).toMatchObject({ channel: 'google', error: 'The enquiry has no phone number', attempts: 1 });
    expect(screen.events[0].id).toBe(failed.id); // what needs attention is listed first
    expect(screen.by_channel).toEqual([expect.objectContaining({ channel: 'google', leads: 2, failed: 1 })]);
    expect(screen.events.find((e: { summary: string | null }) => e.summary?.startsWith('Test lead'))).toMatchObject({ status: 'ignored' });

    await (await w.as('sales')).get('/api/crm/integrations').expect(403);
    await marketing.post(`/api/crm/events/${failed.id}/ignore`).send({}).expect(200);
    const after = (await marketing.get('/api/crm/integrations').expect(200)).body.data;
    expect(after.events.filter((e: { status: string }) => e.status === 'failed')).toEqual([]);
  });
});

describe('Meta lead ads (Facebook and Instagram)', () => {
  const leadgen = (id: string) => ({
    object: 'page',
    entry: [{ id: '1122334455', time: 1791500000, changes: [{ field: 'leadgen', value: { leadgen_id: id, page_id: '1122334455', form_id: '998877', ad_id: '5544', created_time: 1791500000 } }] }],
  });

  it('accepts nothing until Meta is connected, and then only what Meta has signed', async () => {
    await fromMeta('/api/hooks/meta', leadgen('1001')).expect(503);
    Object.assign(config, { metaAppSecret: SECRET, metaVerifyToken: 'verify-me-123' });

    await request(w.app).get('/api/hooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42').expect(403);
    const ok = await request(w.app).get('/api/hooks/meta?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=1158201444').expect(200);
    expect(ok.text).toBe('1158201444');

    await request(w.app).post('/api/hooks/meta').send(leadgen('1001')).expect(403); // no signature
    await fromMeta('/api/hooks/meta', leadgen('1001'), 'someone-elses-secret').expect(403);
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from channel_events where channel = 'meta'`);
    expect(n!.n).toBe(0);
  });

  it('stores the lead even before it can read it, and creates it once the page token is set', async () => {
    const before = await leadCount();
    const got = await fromMeta('/api/hooks/meta', leadgen('1001')).expect(200);
    expect(got.body).toEqual({ received: 1 });
    expect(await leadCount()).toBe(before);
    const marketing = await w.as('marketing');
    let screen = (await marketing.get('/api/crm/integrations').expect(200)).body.data;
    expect(screen.meta).toEqual({ app_secret: true, verify_token: true, page_access_token: false });
    expect(screen.events[0]).toMatchObject({ channel: 'meta', status: 'failed' });
    expect(screen.events[0].error).toContain('page access token is not set');

    config.metaPageAccessToken = 'page-token-abc';
    graph.set('1001', { status: 200, body: {
      id: '1001', campaign_name: 'Diwali cruiser offer', ad_name: 'Reel 3', form_id: '998877', platform: 'ig',
      field_data: [
        { name: 'full_name', values: ['Asha Rao'] }, { name: 'phone_number', values: ['+919820011111'] },
        { name: 'email', values: ['asha@example.com'] }, { name: 'which_board_are_you_looking_for?', values: ['Cruiser'] },
      ],
    } });
    const retried = await marketing.post('/api/crm/integrations/retry').send({}).expect(200);
    expect(retried.body.data).toEqual({ processed: 1, failed: 0 });
    expect(asked.at(-1)).toContain(`/${config.metaGraphVersion}/1001?fields=`);
    expect(asked.at(-1)).toContain('access_token=page-token-abc');

    const l = await leadByPhone('+919820011111');
    expect(l).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', source_name: 'Meta Ads', source_detail: 'Diwali cruiser offer', external_ref: 'meta:1001', stage: 'new' });
    expect(l!.notes).toBe('Which board are you looking for?: Cruiser');
    screen = (await marketing.get('/api/crm/integrations').expect(200)).body.data;
    expect(screen.events.find((e: { channel: string }) => e.channel === 'meta')).toMatchObject({ status: 'processed', lead_no: l!.lead_no, summary: 'Asha Rao, +919820011111 · Diwali cruiser offer', attempts: 2 });
  });

  it('ignores a repeat delivery, and says why when Meta will not hand a lead over', async () => {
    const before = await leadCount();
    const again = await fromMeta('/api/hooks/meta', leadgen('1001')).expect(200);
    expect(again.body).toEqual({ received: 0 });
    graph.set('1002', { status: 400, body: { error: { message: 'Missing leads_retrieval permission' } } });
    await fromMeta('/api/hooks/meta', leadgen('1002')).expect(200);
    expect(await leadCount()).toBe(before);
    const [e] = await rows<{ status: string; error: string }>(w.db, sql`select status, error from channel_events where external_id = '1002'`);
    expect(e!.status).toBe('failed');
    expect(e!.error).toContain('Missing leads_retrieval permission');
  });
});

describe('WhatsApp messages', () => {
  const message = (id: string, from: string, body: string, name: string, extra: object = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '7788', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '912055500100', phone_number_id: '99' },
      contacts: [{ profile: { name }, wa_id: from }],
      messages: [{ from, id, timestamp: '1791500100', type: 'text', text: { body }, ...extra }],
    } }] }],
  });

  it('starts a lead from the first message of an unknown number', async () => {
    const before = await leadCount();
    await request(w.app).post('/api/hooks/whatsapp').send(message('wamid.A1', '919820033333', 'Hi, price of the 42 inch longboard?', 'Neha K')).expect(403);
    await fromMeta('/api/hooks/whatsapp', message('wamid.A1', '919820033333', 'Hi, price of the 42 inch longboard?', 'Neha K')).expect(200);
    expect(await leadCount()).toBe(before + 1);
    const l = await leadByPhone('+919820033333');
    expect(l).toMatchObject({ name: 'Neha K', source_name: 'WhatsApp', source_detail: null, stage: 'new', notes: 'WhatsApp: Hi, price of the 42 inch longboard?', owner_role: 'sales' });
  });

  it('puts later messages on the same lead instead of making new ones', async () => {
    const before = await leadCount();
    await fromMeta('/api/hooks/whatsapp', message('wamid.A2', '919820033333', 'Do you deliver to Nashik?', 'Neha K')).expect(200);
    await fromMeta('/api/hooks/whatsapp', message('wamid.A2', '919820033333', 'Do you deliver to Nashik?', 'Neha K')).expect(200); // Meta repeating itself
    expect(await leadCount()).toBe(before);
    const l = await leadByPhone('+919820033333');
    const timeline = await rows<{ type: string; note: string }>(w.db, sql`select type, note from lead_activities where lead_id = ${l!.id} and type = 'whatsapp'`);
    expect(timeline).toEqual([{ type: 'whatsapp', note: 'They wrote: Do you deliver to Nashik?' }]);
  });

  it('knows which ad a Click-to-WhatsApp message came from', async () => {
    const referral = { source_url: 'https://fb.me/abc', source_id: '120200000', source_type: 'ad', headline: 'Cruiser boards from ₹5,900', body: 'Chat with us', ctwa_clid: 'ARA...' };
    await fromMeta('/api/hooks/whatsapp', message('wamid.B1', '919820044444', 'Hello! Can I get more info on this?', 'Imran', { referral })).expect(200);
    const l = await leadByPhone('+919820044444');
    expect(l).toMatchObject({ name: 'Imran', source_name: 'Meta Ads', source_detail: 'Cruiser boards from ₹5,900' });
  });

  it('skips delivery receipts, and sets aside numbers it cannot use', async () => {
    const before = await leadCount();
    const receipts = { object: 'whatsapp_business_account', entry: [{ id: '7788', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }] };
    expect((await fromMeta('/api/hooks/whatsapp', receipts).expect(200)).body).toEqual({ received: 0 });
    await fromMeta('/api/hooks/whatsapp', message('wamid.C1', '14155550123', 'Hi', 'Sam')).expect(200);
    expect(await leadCount()).toBe(before);
    const [e] = await rows<{ status: string; error: string }>(w.db, sql`select status, error from channel_events where external_id = 'wamid.C1'`);
    expect(e).toEqual({ status: 'failed', error: '+14155550123 is not an Indian mobile number' });
  });
});

describe('website forms', () => {
  it('takes a plain form post against a campaign link', async () => {
    const before = await leadCount();
    const res = await request(w.app).post(`/api/hooks/form/${websiteToken}`).send({ full_name: 'Karan Mehta', mobile: '98200 55555', email_address: 'karan@example.com', message: 'Need 10 boards for a school' }).expect(201);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // The same thing from an ordinary HTML form (not JSON).
    await request(w.app).post(`/api/hooks/form/${websiteToken}`).type('form').send({ name: 'Leena', phone: '9820066666' }).expect(201);
    expect(await leadCount()).toBe(before + 2);
    expect(await leadByPhone('+919820055555')).toMatchObject({ name: 'Karan Mehta', email: 'karan@example.com', source_name: 'Website', source_detail: 'Website contact form', notes: 'Need 10 boards for a school' });

    await request(w.app).post(`/api/hooks/form/${websiteToken}`).send({ name: 'No phone' }).expect(400);
    await request(w.app).post('/api/hooks/form/not-a-real-token').send({ name: 'x', phone: '9820077777' }).expect(404);
    await request(w.app).options(`/api/hooks/form/${websiteToken}`).expect(204);
  });
});

describe('reading what the forms send', () => {
  it('finds the name, phone and email whatever the form calls them', () => {
    expect(fromGoogleColumns([
      { column_id: 'FIRST_NAME', string_value: 'Meera' }, { column_id: 'LAST_NAME', string_value: 'Pillai' },
      { column_id: 'WORK_PHONE', string_value: '+91 98200 12345' }, { column_id: 'WORK_EMAIL', string_value: 'not-an-email' },
      { column_id: 'COMPANY_NAME', string_value: 'Skate School' }, { column_id: 'CITY', string_value: '  ' },
    ])).toEqual({ name: 'Meera Pillai', phone: '+91 98200 12345', email: null, extras: [['Company name', 'Skate School']] });
    expect(fromMetaFields([{ name: 'first_name', values: ['Dev'] }, { name: 'phone', values: ['9820012345'] }, { name: 'budget', values: ['5k', '10k'] }]))
      .toEqual({ name: 'Dev', phone: '9820012345', email: null, extras: [['Budget', '5k, 10k']] });
  });
});

describe('quick replies and one-tap contact', () => {
  it('fills a message with the lead\'s own details', () => {
    const v = { name: 'Asha Rao', myName: 'Amit', company: 'Radboards', products: [] as string[] };
    expect(renderTemplate('Hi {first_name}, {my_name} from {company} here about {products}. {unknown}', v))
      .toBe('Hi Asha, Amit from Radboards here about our products. {unknown}');
    expect(renderTemplate('{products}', { ...v, products: ['Cruiser'] })).toBe('Cruiser');
    expect(renderTemplate('{products}', { ...v, products: ['Cruiser', 'Helmet', 'Wheels'] })).toBe('Cruiser, Helmet and Wheels');
  });

  it('comes with starter replies that marketing can change and sales can use', async () => {
    const sales = await w.as('sales');
    const marketing = await w.as('marketing');
    const list = (await sales.get('/api/crm/templates').expect(200)).body.data;
    expect(list.map((t: { name: string }) => t.name)).toEqual(['First hello', 'Follow-up', 'Visit the showroom']);
    await sales.post('/api/crm/templates').send({ name: 'Mine', body: 'Hi' }).expect(403);
    const added = await marketing.post('/api/crm/templates').send({ name: 'Price list', body: 'Hi {first_name}, here is our price list.', sort_order: 9 }).expect(201);
    await marketing.patch(`/api/crm/templates/${added.body.data.id}`).send({ active: false }).expect(200);
    await marketing.post('/api/crm/templates').send({ name: 'Price list', body: 'again' }).expect(409);
  });

  it('one tap: the message is ready, the contact is logged, and the lead has a follow-up', async () => {
    const sales = await w.as('sales');
    const lead = await leadByPhone('+919820011111'); // Asha, from the Meta ad, still New
    await sales.patch(`/api/leads/${lead!.id}`).send({ interested_item_ids: [itemId] }).expect(200);
    const hello = (await sales.get('/api/crm/templates').expect(200)).body.data[0];

    const res = await sales.post(`/api/crm/leads/${lead!.id}/contact`).send({ template_id: hello.id }).expect(200);
    const text = 'Hi Asha, this is sales user from Radboards Pvt Ltd. Thanks for your enquiry about Longboard 42. When is a good time for a quick call?';
    expect(res.body.data).toMatchObject({ text, stage: 'contacted', stage_label: 'Contacted', whatsapp_url: `https://wa.me/919820011111?text=${encodeURIComponent(text)}` });
    expect(new Date(res.body.data.next_follow_up_at).getTime()).toBeGreaterThan(Date.now());

    const after = (await sales.get(`/api/leads/${lead!.id}`).expect(200)).body.data;
    expect(after.stage).toBe('contacted');
    expect(after.first_contacted_at).toBeTruthy();
    const notes = after.activities.map((a: { type: string; note: string }) => `${a.type}: ${a.note}`);
    expect(notes).toContain(`whatsapp: Sent "First hello": ${text}`);
    expect(notes).toContain('stage_change: New -> Contacted');

    // A call on a lead already in progress: logged, stage untouched, and no template needed.
    const call = await sales.post(`/api/crm/leads/${lead!.id}/contact`).send({ channel: 'call' }).expect(200);
    expect(call.body.data).toMatchObject({ text: '', stage: 'contacted', whatsapp_url: 'https://wa.me/919820011111' });
    const inactive = (await sales.get('/api/crm/templates').expect(200)).body.data.find((t: { active: boolean }) => !t.active);
    await sales.post(`/api/crm/leads/${lead!.id}/contact`).send({ template_id: inactive.id }).expect(400);
    await (await w.as('accounts')).post(`/api/crm/leads/${lead!.id}/contact`).send({}).expect(403);
  });

  it('tells each salesperson how many leads are waiting for them', async () => {
    const sales = await w.as('sales');
    const mine = (await sales.get('/api/dashboards/overview').expect(200)).body.data.my_leads;
    const [truth] = await rows<{ fresh: number }>(w.db, sql`
      select count(*) filter (where l.stage = 'new')::int as fresh from leads l join users u on u.id = l.owner_id where u.role = 'sales'`);
    expect(mine.fresh).toBe(truth!.fresh);
    expect(mine.fresh).toBeGreaterThan(0);
  });
});

describe('ad spend and cost per lead', () => {
  it('turns what was spent into cost per lead on the marketing dashboard', async () => {
    const marketing = await w.as('marketing');
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const spend = (body: object) => marketing.post('/api/crm/spend').send({ spend_date: today, ...body });
    await (await w.as('sales')).post('/api/crm/spend').send({ source_id: m.source('Google Ads'), spend_date: today, amount: 100 }).expect(403);
    await spend({ source_id: m.source('Google Ads'), amount: 0 }).expect(400);

    await spend({ source_id: m.source('Google Ads'), amount: 900 }).expect(201); // on Google in general
    await spend({ source_id: m.source('Google Ads'), detail: 'Google - longboard search', amount: '300' }).expect(201);
    const diwali = await spend({ source_id: m.source('Meta Ads'), detail: 'Diwali cruiser offer', amount: 500 }).expect(201);
    await spend({ source_id: m.source('Meta Ads'), detail: 'Brand awareness', amount: 250 }).expect(201);

    let d = (await marketing.get('/api/dashboards/marketing').expect(200)).body.data;
    const source = (name: string) => d.by_source.find((s: { source: string }) => s.source === name);
    // Google: one lead (Vikram) for 1,200. Meta: two leads (Asha from the form, Imran from the WhatsApp ad) for 750.
    expect(source('Google Ads')).toMatchObject({ leads: 1, spend: '1200.00', cost_per_lead: '1200.00', cost_per_conversion: null });
    expect(source('Meta Ads')).toMatchObject({ leads: 2, spend: '750.00', cost_per_lead: '375.00' });
    expect(source('Website')).toMatchObject({ spend: '0.00', cost_per_lead: null });
    const campaign = (name: string) => d.leads_by_campaign.find((c: { campaign: string }) => c.campaign === name);
    expect(campaign('Diwali cruiser offer')).toMatchObject({ source: 'Meta Ads', leads: 1, spend: '500.00', cost_per_lead: '500.00' });
    expect(campaign('Google - longboard search')).toMatchObject({ leads: 1, spend: '300.00', cost_per_lead: '300.00' });
    expect(campaign('Brand awareness')).toMatchObject({ leads: 0, spend: '250.00', cost_per_lead: null }); // money spent, nothing came of it
    expect(d.spend).toEqual({ total: '1950.00', leads_from_paid_sources: 3, cost_per_lead: '650.00' });

    const list = (await marketing.get('/api/crm/spend').expect(200)).body;
    expect(list.data).toHaveLength(4);
    expect(list.campaign_names.map((c: { detail: string }) => c.detail)).toContain('Diwali cruiser offer');

    await marketing.delete(`/api/crm/spend/${diwali.body.data.id}`).expect(200);
    d = (await marketing.get('/api/dashboards/marketing').expect(200)).body.data;
    expect(source('Meta Ads')).toMatchObject({ spend: '250.00', cost_per_lead: '125.00' });
    expect(d.spend.total).toBe('1450.00');
  });
});
