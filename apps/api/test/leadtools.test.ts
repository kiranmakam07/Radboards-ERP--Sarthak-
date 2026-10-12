import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { masters, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

const leadRow = async (leadId: string) => (await rows<Record<string, any>>(w.db, sql`select * from leads where id = ${leadId}`))[0] as Record<string, any>;
const notes = async (leadId: string) =>
  (await rows<{ note: string }>(w.db, sql`select note from lead_activities where lead_id = ${leadId} and type = 'note' order by at`)).map((a) => a.note);
const daysFromNow = (d: Date | string) => (new Date(d).getTime() - Date.now()) / 86_400_000;
/** Pretend the plan was started this many days ago. */
const age = (leadId: string, days: number) => rows(w.db, sql`update leads set plan_started_at = now() - make_interval(days => ${days}) where id = ${leadId}`);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  const user = async (role: string) => (await rows<{ id: string }>(w.db, sql`select id from users where role::text = ${role}`))[0]!.id;
  id.sales = await user('sales');
  id.store = await user('store');
  // The quick replies every installation starts with.
  const reply = async (name: string) => (await rows<{ id: string }>(w.db, sql`select id from message_templates where name = ${name}`))[0]!.id;
  id.hello = await reply('First hello');
  id.nudge = await reply('Follow-up');
});
afterAll(async () => {
  await w.close();
});

describe('bringing leads in from a spreadsheet', () => {
  it('adds each new number once, notes the ones already here, and lists the rows it could not read', async () => {
    const marketing = await w.as('marketing');
    const existing = (await marketing.post('/api/leads').send({ name: 'Asha Rao', phone: '9820011111', source_id: m.source('Website') }).expect(201)).body.data.id;
    const csv = [
      'Customer Name,Mobile No.,Email,City',
      'Vikram Shah, 98200 22222 ,VIKRAM@Example.com,Pune',
      'Asha R,+91-9820011111,,Mumbai',
      'Bad Number,12345,,Delhi',
      ',9820033333,not-an-email,',
      ',,,',
    ].join('\r\n');
    const res = await marketing.post('/api/leads/import').send({ csv, source_id: m.source('Offline Campaign'), source_detail: 'Expo visitors', owner_id: id.sales }).expect(201);
    expect(res.body.data).toEqual({ rows: 4, added: 2, already_here: 1, problems: [{ row: 4, message: '"12345" is not an Indian mobile number' }] });

    const [vikram] = await rows<Record<string, any>>(w.db, sql`
      select l.*, s.name as source_name from leads l join lead_sources s on s.id = l.source_id where l.phone = '+919820022222'`);
    expect(vikram).toMatchObject({ name: 'Vikram Shah', email: 'vikram@example.com', source_name: 'Offline Campaign', source_detail: 'Expo visitors', owner_id: id.sales, notes: 'Pune', stage: 'new' });
    const [nameless] = await rows<Record<string, any>>(w.db, sql`select name, email from leads where phone = '+919820033333'`);
    expect(nameless).toEqual({ name: 'Imported lead', email: null });
    // The number that was already a lead is not doubled; the row is on its timeline.
    expect(await rows(w.db, sql`select 1 from leads where phone = '+919820011111'`)).toHaveLength(1);
    const [again] = await rows<{ note: string }>(w.db, sql`select note from lead_activities where lead_id = ${existing} and type = 'enquiry' order by at desc limit 1`);
    expect(again!.note).toBe('Repeat enquiry via Offline Campaign / Expo visitors: Mumbai');

    expect((await marketing.post('/api/leads/import').send({ csv: 'Name,City\nA,Pune\n', source_id: m.source('Website') }).expect(400)).body.error.message).toMatch(/No phone column was found/);
    await (await w.as('sales')).post('/api/leads/import').send({ csv, source_id: m.source('Website') }).expect(403);
  });
});

describe('handing over many leads at once', () => {
  it('moves the open ones to the person chosen and leaves closed ones where they are', async () => {
    const marketing = await w.as('marketing');
    const all = await rows<{ id: string; phone: string }>(w.db, sql`select id, phone from leads order by created_at`);
    const lost = all.find((l) => l.phone === '+919820033333')!.id;
    await (await w.as('sales')).post(`/api/leads/${lost}/stage`).send({ stage: 'lost', lost_reason_id: (await rows<{ id: string }>(w.db, sql`select id from lost_reasons limit 1`))[0]!.id }).expect(200);
    const before = (await leadRow(lost)).owner_id;

    const res = await marketing.post('/api/leads/bulk-assign').send({ ids: all.map((l) => l.id), owner_id: id.store }).expect(200);
    expect(res.body.data).toEqual({ moved: 2, owner: 'store user' });
    expect((await leadRow(all[0]!.id)).owner_id).toBe(id.store);
    expect((await leadRow(lost)).owner_id).toBe(before);
    // Doing it again moves nothing: they are already with that person.
    expect((await marketing.post('/api/leads/bulk-assign').send({ ids: all.map((l) => l.id), owner_id: id.store }).expect(200)).body.data.moved).toBe(0);
    await marketing.post('/api/leads/bulk-assign').send({ ids: [], owner_id: id.store }).expect(400);
    await (await w.as('sales')).post('/api/leads/bulk-assign').send({ ids: [all[0]!.id], owner_id: id.sales }).expect(403);
  });
});

describe('follow-up plans', () => {
  let planId: string;
  let leadId: string;

  it('puts every new lead on the usual plan, due on the day of its first step', async () => {
    const marketing = await w.as('marketing');
    await marketing.post('/api/leads/plans').send({ name: 'Empty', steps: [] }).expect(400);
    await marketing.post('/api/leads/plans').send({ name: 'Bad', steps: [{ after_days: 0, what: 'x', template_id: '00000000-0000-4000-8000-000000000000' }] }).expect(400);
    // Steps given out of order are kept in order of the day.
    const plan = await marketing.post('/api/leads/plans').send({
      name: 'New enquiry', is_default: true,
      steps: [
        { after_days: 7, what: 'Last check: still interested?', template_id: '' },
        { after_days: 0, what: 'Say hello', template_id: id.hello },
        { after_days: 2, what: 'Follow up', template_id: id.nudge },
      ],
    }).expect(201);
    planId = plan.body.data.id;
    expect(plan.body.data.steps.map((s: any) => s.after_days)).toEqual([0, 2, 7]);

    const sales = await w.as('sales');
    leadId = (await marketing.post('/api/leads').send({ name: 'Neha Kulkarni', phone: '9820044444', source_id: m.source('Meta Ads'), owner_id: id.sales }).expect(201)).body.data.id;
    const lead = (await sales.get(`/api/leads/${leadId}`).expect(200)).body.data;
    expect(lead.plan).toMatchObject({ id: planId, name: 'New enquiry', step: 0 });
    expect(lead.plan.steps.map((s: any) => [s.what, s.state, s.template_name])).toEqual([
      ['Say hello', 'now', 'First hello'], ['Follow up', 'later', 'Follow-up'], ['Last check: still interested?', 'later', null],
    ]);
    expect(Math.abs(daysFromNow(lead.next_follow_up_at))).toBeLessThan(0.01); // due now, not in the usual few days
    expect(await notes(leadId)).toContain('Started the follow-up plan "New enquiry"');
    expect((await sales.get('/api/leads/plans').expect(200)).body.data[0]).toMatchObject({ name: 'New enquiry', is_default: true, leads_on_it: 1 });
  });

  it('moves to the next step when the lead is contacted on its day, and not when contacted early', async () => {
    const sales = await w.as('sales');
    // The hello goes out: step one is done, the lead is due again on day 2.
    await sales.post(`/api/crm/leads/${leadId}/contact`).send({ channel: 'whatsapp', template_id: id.hello }).expect(200);
    let l = await leadRow(leadId);
    expect(l).toMatchObject({ plan_step: 1, stage: 'contacted' });
    expect(daysFromNow(l.next_follow_up_at)).toBeGreaterThan(1.99);
    expect(daysFromNow(l.next_follow_up_at)).toBeLessThan(2.01);

    // A call the same afternoon is an extra contact: the day-2 follow-up still stands.
    await sales.post(`/api/leads/${leadId}/activities`).send({ type: 'call', note: 'They called back' }).expect(201);
    expect((await leadRow(leadId)).plan_step).toBe(1);

    // Three days on, the follow-up is sent: on to the last step, due on day 7.
    await age(leadId, 3);
    await sales.post(`/api/crm/leads/${leadId}/contact`).send({ channel: 'whatsapp', template_id: id.nudge }).expect(200);
    l = await leadRow(leadId);
    expect(l.plan_step).toBe(2);
    expect(daysFromNow(l.next_follow_up_at)).toBeGreaterThan(3.99);
    expect(daysFromNow(l.next_follow_up_at)).toBeLessThan(4.01);
    // A note is not a contact.
    await age(leadId, 8);
    await sales.post(`/api/leads/${leadId}/activities`).send({ type: 'note', note: 'Thinking about it' }).expect(201);
    expect((await leadRow(leadId)).plan_step).toBe(2);

    // The last step done: the plan is finished and comes off the lead.
    await sales.post(`/api/leads/${leadId}/activities`).send({ type: 'call', note: 'Last check' }).expect(201);
    l = await leadRow(leadId);
    expect(l).toMatchObject({ plan_id: null, plan_step: null, plan_started_at: null });
    expect(await notes(leadId)).toContain('Finished the follow-up plan "New enquiry"');
    expect((await sales.get(`/api/leads/${leadId}`).expect(200)).body.data.plan).toBeNull();
  });

  it('can be started and stopped by hand, and comes off a lead that is lost', async () => {
    const sales = await w.as('sales');
    await sales.post(`/api/leads/${leadId}/plan`).send({ plan_id: planId }).expect(200);
    expect((await leadRow(leadId)).plan_step).toBe(0);
    await sales.delete(`/api/leads/${leadId}/plan`).expect(200);
    expect((await leadRow(leadId)).plan_id).toBeNull();
    expect((await notes(leadId)).at(-1)).toBe('Follow-up plan stopped: stopped by sales user');

    await sales.post(`/api/leads/${leadId}/plan`).send({ plan_id: planId }).expect(200);
    await sales.post(`/api/leads/${leadId}/stage`).send({ stage: 'lost', lost_reason_id: (await rows<{ id: string }>(w.db, sql`select id from lost_reasons limit 1`))[0]!.id }).expect(200);
    expect(await leadRow(leadId)).toMatchObject({ plan_id: null, plan_step: null, stage: 'lost' });
    expect((await sales.post(`/api/leads/${leadId}/plan`).send({ plan_id: planId }).expect(400)).body.error.message).toMatch(/closed/);
    await (await w.as('hr')).post(`/api/leads/${leadId}/plan`).send({ plan_id: planId }).expect(403);
  });

  it('keeps one usual plan, and a plan switched off is not started on new leads', async () => {
    const marketing = await w.as('marketing');
    const other = (await marketing.post('/api/leads/plans').send({ name: 'Dealer enquiry', is_default: true, steps: [{ after_days: 1, what: 'Call', template_id: '' }] }).expect(201)).body.data.id;
    const plans = (await marketing.get('/api/leads/plans').expect(200)).body.data;
    expect(plans.filter((p: any) => p.is_default).map((p: any) => p.name)).toEqual(['Dealer enquiry']);

    await marketing.patch(`/api/leads/plans/${other}`).send({ active: false }).expect(200);
    const fresh = (await marketing.post('/api/leads').send({ name: 'No Plan', phone: '9820055555', source_id: m.source('Website') }).expect(201)).body.data.id;
    expect((await leadRow(fresh)).plan_id).toBeNull();
    expect(daysFromNow((await leadRow(fresh)).next_follow_up_at)).toBeGreaterThan(0.5); // the usual first follow-up, a few days out
    await (await w.as('sales')).patch(`/api/leads/plans/${planId}`).send({ name: 'Mine now' }).expect(403);
  });
});

describe('the team, person by person', () => {
  it('shows what each person received, how fast they answered, and what is waiting', async () => {
    const data = (await (await w.as('marketing')).get('/api/dashboards/marketing').expect(200)).body.data;
    const of = (name: string) => data.team.find((t: any) => t.name === name);
    // Sales was given three: Neha (answered within the minute, later lost), the nameless one from the spreadsheet
    // (lost without being contacted) and the last lead, which is still open.
    expect(of('sales user')).toMatchObject({ received: 3, contacted: 1, converted: 0, open_now: 1, overdue: 0 });
    expect(of('sales user').avg_response_min).toBeLessThanOrEqual(1);
    // The store user was handed the two open leads from the spreadsheet test; nobody has contacted them yet.
    expect(of('store user')).toMatchObject({ received: 2, contacted: 0, open_now: 2 });
    expect(of('store user').avg_response_min).toBeNull();
  });
});
