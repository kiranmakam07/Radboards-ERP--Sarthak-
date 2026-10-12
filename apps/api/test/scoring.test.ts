import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { masters, openingStock, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

const lead = async (name: string, phone: string, items: string[] = []) => {
  const sales = await w.as('sales');
  const res = await sales.post('/api/leads').send({ name, phone, source_id: m.source('Website'), interested_item_ids: items }).expect(201);
  return res.body.data.id as string;
};
const one = async (leadId: string) => (await (await w.as('sales')).get(`/api/leads/${leadId}`).expect(200)).body.data;
const soon = () => new Date(Date.now() + 86400_000).toISOString();

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const admin = await w.as('admin');
  const item = async (sku: string, price: number) =>
    (await admin.post('/api/items').send({ sku, name: sku, item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18, retail_price: price, purchase_cost: 100 }).expect(201)).body.data.id as string;
  id.helmet = await item('HLM-01', 1534);
  id.longboard = await item('BRD-LONG', 9440);
  await openingStock(w, m.showroom, [{ item_id: id.helmet!, qty_change: '5', unit_cost: '700.00' }]);
});
afterAll(async () => {
  await w.close();
});

describe('lead score', () => {
  it('adds up what is known about a lead, and shows the points behind the number', async () => {
    // Just arrived, wants nothing in particular: 10 for being new + 10 for being fresh.
    id.plain = await lead('Plain Enquiry', '9811000001');
    expect(await one(id.plain!)).toMatchObject({ score: 20, score_label: 'cold', score_points: { stage: 10, interest: 0, contact: 0, fresh: 10, repeat: 0 } });

    // Named a cheap item: 5 more. Named one that sells for 5,000 or more: 15, which makes it warm.
    id.cheap = await lead('Wants A Helmet', '9811000002', [id.helmet!]);
    expect(await one(id.cheap!)).toMatchObject({ score: 25, score_label: 'cold' });
    id.keen = await lead('Wants A Longboard', '9811000003', [id.helmet!, id.longboard!]);
    expect(await one(id.keen!)).toMatchObject({ score: 35, score_label: 'warm', score_points: { interest: 15 } });

    // Two calls and a move to Interested: 40 for the stage + 15 for the item + 10 for the calls + 10 fresh.
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${id.keen}/activities`).send({ type: 'call', note: 'Asked about delivery' }).expect(201);
    await sales.post(`/api/leads/${id.keen}/activities`).send({ type: 'call', note: 'Called back with the price' }).expect(201);
    await sales.post(`/api/leads/${id.keen}/activities`).send({ type: 'note', note: 'A note is not a conversation' }).expect(201);
    await sales.post(`/api/leads/${id.keen}/stage`).send({ stage: 'contacted', next_follow_up_at: soon() }).expect(200);
    await sales.post(`/api/leads/${id.keen}/stage`).send({ stage: 'interested', next_follow_up_at: soon() }).expect(200);
    expect(await one(id.keen!)).toMatchObject({ score: 75, score_label: 'hot', score_points: { stage: 40, interest: 15, contact: 10, fresh: 10, repeat: 0 } });

    // They wrote to us themselves (a WhatsApp message arriving has nobody's name on it): 5 for the message + 10 for it being theirs.
    await rows(w.db, sql`insert into lead_activities (lead_id, type, note) values (${id.cheap}, 'whatsapp', 'They wrote: is it in stock?')`);
    expect(await one(id.cheap!)).toMatchObject({ score: 40, score_label: 'warm', score_points: { contact: 15 } });
  });

  it('cools a lead nobody has spoken to for two weeks, and never goes below zero or above a hundred', async () => {
    const age = async (leadId: string) => {
      await rows(w.db, sql`update lead_activities set at = now() - interval '20 days' where lead_id = ${leadId} and type not in ('call', 'whatsapp')`);
      await rows(w.db, sql`update leads set created_at = now() - interval '20 days' where id = ${leadId}`);
    };
    await age(id.plain!);
    expect(await one(id.plain!)).toMatchObject({ score: 0, score_label: 'cold', score_points: { stage: 10, fresh: -15 } });
    // An old lead that was spoken to yesterday is not stale.
    await age(id.cheap!);
    expect((await one(id.cheap!)).score_points.fresh).toBe(0);
    // Old conversations stop counting after a week.
    await rows(w.db, sql`update lead_activities set at = now() - interval '8 days' where lead_id = ${id.keen} and type = 'call'`);
    expect((await one(id.keen!)).score_points.contact).toBe(0);
  });

  it('knows someone who has bought before', async () => {
    // A customer added straight to the parties list, who has been billed, now enquires about something bigger.
    const party = await (await w.as('sales')).post('/api/parties').send({ party_type: 'customer', name: 'Old Customer', phone: '9811000009' }).expect(201);
    await (await w.as('store')).post('/api/sales/quick-bill').send({
      party_id: party.body.data.id, lines: [{ item_id: id.helmet, qty: 1 }], payments: [{ mode: 'cash', amount: 1534 }],
    }).expect(201);
    id.back = await lead('Old Customer', '9811000009', [id.longboard!]);
    expect(await one(id.back!)).toMatchObject({ score: 45, score_label: 'warm', score_points: { stage: 10, interest: 15, fresh: 10, repeat: 10 } });
  });

  it('has no score once a lead is won or lost, and sorts the list hottest first', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${id.plain}/stage`).send({ stage: 'lost', lost_reason_id: (await rows<{ id: string }>(w.db, sql`select id from lost_reasons limit 1`))[0]!.id }).expect(200);
    expect(await one(id.plain!)).toMatchObject({ score: null, score_label: null, score_points: null });

    const list = (await sales.get('/api/leads?sort=score').expect(200)).body.data as { name: string; score: number | null; score_label: string | null }[];
    const scored = list.filter((l) => l.score !== null).map((l) => l.score!);
    expect(scored).toEqual([...scored].sort((a, b) => b - a));
    expect(list[0]).toMatchObject({ name: 'Wants A Longboard', score_label: 'hot' });
    expect(list.at(-1)!.score).toBeNull(); // won and lost leads go to the end
    const board = (await sales.get('/api/leads/pipeline').expect(200)).body.data as { name: string; score: number }[];
    expect(board.find((l) => l.name === 'Wants A Longboard')!.score).toBe(list[0]!.score);
  });
});

describe('alert when a lead arrives', () => {
  it('tells the person the lead was given to, and whoever looks after lead sources, but not the one who typed it in', async () => {
    const sales = await w.as('sales');
    const start = (await sales.get('/api/leads/alerts').expect(200)).body;
    expect(start.data).toEqual([]);
    expect(start.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A lead arrives from outside (the website form has nobody signed in) and is given to sales.
    const [salesUser] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'sales'`);
    const marketing = await w.as('marketing');
    const made = await marketing.post('/api/leads').send({ name: 'Fresh Lead', phone: '9811000020', source_id: m.source('Meta Ads'), source_detail: 'Diwali offer', owner_id: salesUser!.id }).expect(201);

    const forSales = (await sales.get(`/api/leads/alerts?since=${encodeURIComponent(start.now)}`).expect(200)).body;
    expect(forSales.data).toHaveLength(1);
    expect(forSales.data[0]).toMatchObject({ id: made.body.data.id, name: 'Fresh Lead', source_name: 'Meta Ads', source_detail: 'Diwali offer', mine: true });
    // Marketing typed it in, so marketing is not told about it; admin, who manages the sources, is.
    expect((await marketing.get(`/api/leads/alerts?since=${encodeURIComponent(start.now)}`).expect(200)).body.data).toHaveLength(0);
    expect((await (await w.as('admin')).get(`/api/leads/alerts?since=${encodeURIComponent(start.now)}`).expect(200)).body.data[0]).toMatchObject({ name: 'Fresh Lead', mine: false });
    // The store user was not given it and does not manage sources.
    expect((await (await w.as('store')).get(`/api/leads/alerts?since=${encodeURIComponent(start.now)}`).expect(200)).body.data).toHaveLength(0);

    // Asking again from the moment of the last answer brings nothing twice.
    expect((await sales.get(`/api/leads/alerts?since=${encodeURIComponent(forSales.now)}`).expect(200)).body.data).toHaveLength(0);
    await sales.get('/api/leads/alerts?since=yesterday').expect(400);
    await (await w.as('hr')).get('/api/leads/alerts').expect(403);
  });
});
