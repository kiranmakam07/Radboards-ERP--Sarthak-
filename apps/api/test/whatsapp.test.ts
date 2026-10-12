import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import { masters, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let leadId: string;

/** What WhatsApp's servers were asked to send, and what they will answer next. */
const outbox: { url: string; body: any; headers: Record<string, string> }[] = [];
let answer: { status: number; body: unknown } | 'down' = { status: 200, body: { messages: [{ id: 'wamid.TEST1' }] } };

const whatsappNotes = async () =>
  (await rows<{ note: string; user_id: string | null }>(w.db, sql`select note, user_id from lead_activities where lead_id = ${leadId} and type = 'whatsapp' order by at`)).map((a) => a.note);
const lead = async () => (await rows<Record<string, any>>(w.db, sql`select * from leads where id = ${leadId}`))[0] as Record<string, any>;

beforeAll(async () => {
  w = await setup(undefined, async (url, body, headers) => {
    outbox.push({ url, body, headers });
    if (answer === 'down') throw new Error('network is down');
    return answer;
  });
  m = await masters(w.db);
  leadId = (await (await w.as('marketing')).post('/api/leads').send({ name: 'Asha Rao', phone: '9820011111', source_id: m.source('WhatsApp') }).expect(201)).body.data.id;
});
afterAll(async () => {
  Object.assign(config, { whatsappPhoneNumberId: '', whatsappAccessToken: '' });
  await w.close();
});

describe('sending a WhatsApp message from the lead’s page', () => {
  it('says it is not connected until the number is, and sends nothing', async () => {
    const sales = await w.as('sales');
    expect((await sales.get('/api/auth/me').expect(200)).body.whatsapp_send).toBe(false);
    const res = await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Hello' }).expect(503);
    expect(res.body.error.code).toBe('not_configured');
    expect(outbox).toHaveLength(0);
    Object.assign(config, { whatsappPhoneNumberId: '1055500012345', whatsappAccessToken: 'test-token' });
    expect((await sales.get('/api/auth/me').expect(200)).body.whatsapp_send).toBe(true);
  });

  it('sends the message from the business number, logs it, and moves a new lead to Contacted with a follow-up', async () => {
    const sales = await w.as('sales');
    const res = await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: '  The 42 inch longboard is ₹9,440, in stock.  ' }).expect(201);
    expect(res.body.data).toMatchObject({ message_id: 'wamid.TEST1', text: 'The 42 inch longboard is ₹9,440, in stock.', stage: 'contacted', stage_label: 'Contacted' });

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.url).toBe('https://graph.facebook.com/v21.0/1055500012345/messages');
    expect(outbox[0]!.headers).toEqual({ Authorization: 'Bearer test-token' });
    expect(outbox[0]!.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919820011111', type: 'text',
      text: { preview_url: true, body: 'The 42 inch longboard is ₹9,440, in stock.' },
    });
    expect(await whatsappNotes()).toEqual(['We wrote: The 42 inch longboard is ₹9,440, in stock.']);
    const l = await lead();
    expect(l.stage).toBe('contacted');
    expect(l.first_contacted_at).toBeTruthy();
    expect(new Date(l.next_follow_up_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('can send a quick reply, written out for this lead', async () => {
    const admin = await w.as('admin');
    const t = await admin.post('/api/crm/templates').send({ name: 'Thanks', body: 'Hi {first_name}, thanks for asking about {products}. {my_name}, {company}' }).expect(201);
    const sales = await w.as('sales');
    const res = await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ template_id: t.body.data.id }).expect(201);
    expect(res.body.data.text).toBe('Hi Asha, thanks for asking about our products. sales user, Radboards Pvt Ltd');
    expect(outbox.at(-1)!.body.text.body).toBe(res.body.data.text);
    await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({}).expect(400);
    await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: '   ' }).expect(400);
  });

  it('explains WhatsApp’s 24-hour rule in plain words, and logs nothing that was not sent', async () => {
    const sales = await w.as('sales');
    const before = await whatsappNotes();

    answer = { status: 400, body: { error: { code: 131047, message: '(#131047) Re-engagement message' } } };
    const late = await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Still interested?' }).expect(409);
    expect(late.body.error.message).toMatch(/last wrote to us more than 24 hours ago/);

    answer = { status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } };
    expect((await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Hello?' }).expect(409)).body.error.message).toMatch(/does not seem to be on WhatsApp/);

    answer = { status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } };
    const refused = await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Hello?' }).expect(502);
    expect(refused.body.error.message).toBe('WhatsApp did not send it (Invalid OAuth access token).');

    answer = 'down';
    expect((await sales.post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Hello?' }).expect(502)).body.error.code).toBe('whatsapp_unreachable');

    expect(await whatsappNotes()).toEqual(before);
    answer = { status: 200, body: { messages: [{ id: 'wamid.TEST2' }] } };
  });

  it('is for the people who work leads', async () => {
    await (await w.as('hr')).post(`/api/crm/leads/${leadId}/whatsapp`).send({ text: 'Hi' }).expect(403);
    await (await w.as('sales')).post('/api/crm/leads/00000000-0000-4000-8000-000000000000/whatsapp').send({ text: 'Hi' }).expect(404);
    const status = (await (await w.as('marketing')).get('/api/crm/integrations').expect(200)).body.data.whatsapp;
    expect(status).toEqual({ send: true });
  });
});
