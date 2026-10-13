import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDate, istDate } from '@radcore/shared';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

let w: World;

/** What Meta's Graph API would answer. Keyed by the path after the version, without the access token. */
const graph = new Map<string, { status: number; body: unknown }>();
const asked: string[] = [];
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+0000');
const answers = (name: string, phone: string | null, extra: Record<string, string> = {}) => [
  { name: 'full_name', values: [name] }, ...(phone ? [{ name: 'phone_number', values: [phone] }] : []),
  ...Object.entries(extra).map(([k, v]) => ({ name: k, values: [v] })),
];
const leadCount = async () => (await rows<{ n: number }>(w.db, sql`select count(*)::int as n from leads`))[0]!.n;
const leadByPhone = async (phone: string) =>
  (await rows<Record<string, any>>(w.db, sql`select l.*, s.name as source_name from leads l join lead_sources s on s.id = l.source_id where l.phone = ${phone}`))[0];

beforeAll(async () => {
  w = await setup(async (url) => {
    asked.push(url);
    const u = new URL(url);
    u.searchParams.delete('access_token');
    const key = decodeURIComponent(`${u.pathname.replace(/^\/v[\d.]+\//, '')}${u.search}`);
    // Lead lists are asked for with a date filter; the stand-in answers by form and page of results.
    const short = key.replace(/\?fields=id,created_time.*$/, '');
    return graph.get(key) ?? graph.get(short) ?? { status: 400, body: { error: { message: `Unsupported get request: ${short}` } } };
  });
  graph.set('me?fields=id,name', { status: 200, body: { id: '1029384756', name: 'Radboards' } });
  graph.set('1029384756/subscribed_apps?fields=subscribed_fields', { status: 200, body: { data: [{ id: '55', name: 'RadCore', subscribed_fields: ['leadgen', 'messages'] }] } });
  graph.set('1029384756/leadgen_forms?fields=id,name,status&limit=100', { status: 200, body: { data: [{ id: 'F1', name: 'Longboard offer', status: 'ACTIVE' }, { id: 'F2', name: 'Dealer enquiry', status: 'ACTIVE' }] } });
  graph.set('F1/leads', {
    status: 200,
    body: {
      data: [
        { id: 'L1', created_time: ago(20), campaign_name: 'Diwali longboards', platform: 'fb', form_id: 'F1', field_data: answers('Asha Kulkarni', '+91 98200 11111', { city: 'Pune' }) },
        { id: 'L2', created_time: ago(0.02), ad_name: 'Reel 3', platform: 'ig', form_id: 'F1', field_data: answers('Rohan Mehta', '9820022222') },
      ],
      paging: { cursors: { after: 'XYZ' }, next: 'https://graph.facebook.com/v21.0/F1/leads?after=XYZ&access_token=page-token' },
    },
  });
  graph.set('F1/leads?after=XYZ', { status: 200, body: { data: [{ id: 'L3', created_time: ago(3), form_id: 'F1', field_data: answers('Neha Joshi', '9820033333') }] } });
  graph.set('F2/leads', {
    status: 200,
    body: {
      data: [
        { id: 'L4', created_time: ago(5), form_id: 'F2', field_data: answers('No Number', null) },
        // Asha again, on the other form.
        { id: 'L5', created_time: ago(2), form_id: 'F2', field_data: answers('Asha K', '9820011111', { shop_name: 'Asha Sports' }) },
      ],
    },
  });
  graph.set('109988776655?fields=display_phone_number,verified_name,quality_rating', { status: 200, body: { display_phone_number: '+91 98200 00000', verified_name: 'Radboards', quality_rating: 'GREEN', id: '109988776655' } });
});
afterAll(async () => {
  Object.assign(config, { metaAppSecret: '', metaVerifyToken: '', metaPageAccessToken: '', whatsappPhoneNumberId: '', whatsappAccessToken: '' });
  await w.close();
});

describe('checking the Meta and WhatsApp connections', () => {
  it('says what is missing before anything is set, without calling Meta', async () => {
    const marketing = await w.as('marketing');
    const d = (await marketing.post('/api/crm/integrations/check').send({}).expect(200)).body.data;
    expect(d.meta).toMatchObject({ set: { app_secret: false, verify_token: false, page_access_token: false }, page: null, leadgen_subscribed: null, problem: null, verified_at: null });
    expect(d.whatsapp).toMatchObject({ receiving: false, send_set: false, number: null, problem: null });
    expect(asked).toHaveLength(0);
    await (await w.as('sales')).post('/api/crm/integrations/check').send({}).expect(403);
  });

  it('remembers that Meta has accepted the address', async () => {
    Object.assign(config, { metaAppSecret: 'app-secret', metaVerifyToken: 'verify-me' });
    await request(w.app).get('/api/hooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1').expect(403);
    const ok = await request(w.app).get('/api/hooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242').expect(200);
    expect(ok.text).toBe('4242');
    const page = (await (await w.as('marketing')).get('/api/crm/integrations').expect(200)).body.data;
    expect(page.state.meta_verified_at).toBeTruthy();
    expect(page.state.whatsapp_verified_at).toBeNull();
    await request(w.app).get('/api/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=7').expect(200);
    expect((await (await w.as('marketing')).get('/api/crm/integrations').expect(200)).body.data.state.whatsapp_verified_at).toBeTruthy();
  });

  it('names the Page and the number the tokens belong to, and whether the Page sends its lead forms here', async () => {
    Object.assign(config, { metaPageAccessToken: 'page-token', whatsappPhoneNumberId: '109988776655', whatsappAccessToken: 'wa-token' });
    const marketing = await w.as('marketing');
    let d = (await marketing.post('/api/crm/integrations/check').send({}).expect(200)).body.data;
    expect(d.meta).toMatchObject({ page: { id: '1029384756', name: 'Radboards' }, leadgen_subscribed: true, problem: null });
    expect(d.meta.verified_at).toBeTruthy();
    expect(d.whatsapp).toMatchObject({ receiving: true, send_set: true, number: { phone: '+91 98200 00000', name: 'Radboards', quality: 'GREEN' }, problem: null });
    // The token is sent to Meta and nowhere else.
    expect(asked.every((u) => u.startsWith('https://graph.facebook.com/'))).toBe(true);
    expect(JSON.stringify(d)).not.toContain('page-token');

    // The Page is connected but its lead forms are not switched on for the app.
    graph.set('1029384756/subscribed_apps?fields=subscribed_fields', { status: 200, body: { data: [{ id: '55', subscribed_fields: ['messages'] }] } });
    d = (await marketing.post('/api/crm/integrations/check').send({}).expect(200)).body.data;
    expect(d.meta.leadgen_subscribed).toBe(false);
    graph.set('1029384756/subscribed_apps?fields=subscribed_fields', { status: 200, body: { data: [{ id: '55', subscribed_fields: ['leadgen'] }] } });
  });

  it('passes on what Meta says when a token is wrong', async () => {
    const marketing = await w.as('marketing');
    graph.set('me?fields=id,name', { status: 400, body: { error: { message: 'Error validating access token: Session has expired on Monday, 05-Oct-26.', code: 190 } } });
    graph.set('109988776655?fields=display_phone_number,verified_name,quality_rating', { status: 400, body: { error: { message: 'Unsupported get request. Object with ID 109988776655 does not exist' } } });
    const d = (await marketing.post('/api/crm/integrations/check').send({}).expect(200)).body.data;
    expect(d.meta).toMatchObject({ page: null, problem: 'The page access token does not work: Error validating access token: Session has expired on Monday, 05-Oct-26.' });
    expect(d.whatsapp.problem).toMatch(/number or its token does not work: Unsupported get request/);
    graph.set('me?fields=id,name', { status: 200, body: { id: '1029384756', name: 'Radboards' } });
  });
});

describe('bringing in the leads already in Meta’s lead forms', () => {
  it('reads every form, follows the pages of results, and makes leads of the ones not here yet', async () => {
    const marketing = await w.as('marketing');
    await (await w.as('sales')).post('/api/crm/integrations/meta/fetch').send({ days: 30 }).expect(403);
    await marketing.post('/api/crm/integrations/meta/fetch').send({ days: 400 }).expect(400);
    asked.length = 0;
    const r = (await marketing.post('/api/crm/integrations/meta/fetch').send({ days: 30 }).expect(200)).body.data;
    // Five in the forms: three new people, one with no number, and one person a second time.
    expect(r).toEqual({ forms: 2, found: 5, already_here: 0, leads: 4, not_usable: 1, more: false });
    expect(await leadCount()).toBe(3);

    // Only leads of the last 30 days were asked for, and the "next page" link was followed as Meta gave it.
    const first = asked.find((u) => u.includes('/F1/leads?fields='))!;
    const filter = JSON.parse(new URL(first).searchParams.get('filtering')!);
    expect(filter).toEqual([{ field: 'time_created', operator: 'GREATER_THAN', value: expect.any(Number) }]);
    expect(Math.abs(filter[0].value - (Date.now() / 1000 - 30 * 86_400))).toBeLessThan(60);
    expect(asked).toContain('https://graph.facebook.com/v21.0/F1/leads?after=XYZ&access_token=page-token');

    const asha = (await leadByPhone('+919820011111'))!;
    expect(asha).toMatchObject({ name: 'Asha Kulkarni', source_name: 'Meta Ads', source_detail: 'Diwali longboards', external_ref: 'meta:L1', stage: 'new' });
    // Filled in three weeks ago: it says so, so nobody takes it for today's enquiry.
    expect(asha.notes).toBe(`Filled in on ${formatDate(istDate(new Date(Date.now() - 20 * 86_400_000)))}\nCity: Pune`);
    expect(asha.owner_id).toBeTruthy();
    expect(asha.next_follow_up_at).toBeTruthy();
    // Her second form went on the same lead, not a new one.
    const timeline = await rows<{ type: string; note: string }>(w.db, sql`select type, note from lead_activities where lead_id = ${asha.id} order by at`);
    expect(timeline.some((a) => a.type === 'enquiry' && /Repeat enquiry via Meta Ads \/ Dealer enquiry.*Shop name: Asha Sports/s.test(a.note))).toBe(true);
    // Filled in half an hour ago: an ordinary new lead, named after the ad when there is no campaign name.
    expect(await leadByPhone('+919820022222')).toMatchObject({ name: 'Rohan Mehta', source_detail: 'Reel 3', notes: null });
    // No campaign or ad name: the form's own name says where it came from.
    expect(await leadByPhone('+919820033333')).toMatchObject({ source_detail: 'Longboard offer' });

    const page = (await marketing.get('/api/crm/integrations').expect(200)).body.data;
    expect(page.events.filter((e: any) => e.status === 'failed').map((e: any) => e.error)).toEqual(['The enquiry has no phone number']);
    expect(page.by_channel.find((c: any) => c.channel === 'meta')).toMatchObject({ leads: 4, failed: 1 });
  });

  it('adds nothing the second time, and nothing when Meta later announces a lead that was already brought in', async () => {
    const marketing = await w.as('marketing');
    const again = (await marketing.post('/api/crm/integrations/meta/fetch').send({ days: 30 }).expect(200)).body.data;
    expect(again).toEqual({ forms: 2, found: 5, already_here: 5, leads: 0, not_usable: 0, more: false });
    expect(await leadCount()).toBe(3);

    const raw = JSON.stringify({ object: 'page', entry: [{ id: '1029384756', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: 'L2', page_id: '1029384756', form_id: 'F1' } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    const hook = await request(w.app).post('/api/hooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw).expect(200);
    expect(hook.body).toEqual({ received: 0 });
    expect(await leadCount()).toBe(3);
  });

  it('takes in a lead that arrives afterwards, and only that one', async () => {
    (graph.get('F2/leads')!.body as any).data.push({ id: 'L6', created_time: ago(0.01), form_id: 'F2', campaign_name: 'Dealer drive', field_data: answers('Imran Shaikh', '9820044444') });
    const r = (await (await w.as('marketing')).post('/api/crm/integrations/meta/fetch').send({}).expect(200)).body.data;
    expect(r).toMatchObject({ found: 6, already_here: 5, leads: 1, not_usable: 0 });
    expect(await leadByPhone('+919820044444')).toMatchObject({ name: 'Imran Shaikh', source_detail: 'Dealer drive' });
  });

  it('says plainly when the token is missing or Meta will not hand the leads over', async () => {
    const marketing = await w.as('marketing');
    graph.set('1029384756/leadgen_forms?fields=id,name,status&limit=100', { status: 403, body: { error: { message: '(#200) Requires pages_manage_ads permission to manage the object', code: 200 } } });
    const refused = await marketing.post('/api/crm/integrations/meta/fetch').send({ days: 7 }).expect(502);
    expect(refused.body.error.message).toMatch(/Meta would not hand over the leads: \(#200\) Requires pages_manage_ads.*leads_retrieval/);
    config.metaPageAccessToken = '';
    const unset = await marketing.post('/api/crm/integrations/meta/fetch').send({ days: 7 }).expect(503);
    expect(unset.body.error.message).toMatch(/META_PAGE_ACCESS_TOKEN/);
    expect(await leadCount()).toBe(4);
  });
});
