import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/db/client';
import { masters, setup, type World } from './helpers';

/**
 * Personal data (DPDP, brief P3): when and how a person agreed to be contacted; phone numbers and addresses
 * masked in lists for roles without pii:read; and every opening of a customer's full record logged.
 */
let w: World;
let m: Awaited<ReturnType<typeof masters>>;
const id: Record<string, string> = {};

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
});
afterAll(() => w.close());

describe('consent', () => {
  it('is recorded when the person agrees at the counter, and goes with them when they buy', async () => {
    const store = await w.as('store');
    const told = (await store.post('/api/leads/walk-in').send({ phone: '9811000081', name: 'Farah Khan', outcome: 'enquiry', consent: true }).expect(201)).body.data;
    expect(told.lead).toMatchObject({ consent_source: 'told our staff (walk-in)' });
    expect(told.lead.consent_at).toBeTruthy();
    const silent = (await store.post('/api/leads/walk-in').send({ phone: '9811000082', name: 'Gopal Rao', outcome: 'enquiry' }).expect(201)).body.data;
    expect(silent.lead).toMatchObject({ consent_at: null, consent_source: null });
    const bought = (await (await w.as('sales')).post(`/api/leads/${told.lead.id}/convert`).send({ party_type: 'customer' }).expect(200)).body.data;
    id.party = bought.party.id;
    const [party] = await rows<{ consent_source: string | null }>(w.db, sql`select consent_source from parties where id = ${id.party}`);
    expect(party!.consent_source).toBe('told our staff (walk-in)');
  });

  it('can be withdrawn, by an admin, and stays on record as withdrawn', async () => {
    await (await w.as('sales')).patch(`/api/parties/${id.party}`).send({ consent: false }).expect(403);
    await (await w.as('admin')).patch(`/api/parties/${id.party}`).send({ consent: false }).expect(200);
    const [party] = await rows<{ consent_at: string | null; consent_source: string }>(w.db, sql`select consent_at, consent_source from parties where id = ${id.party}`);
    expect(party!.consent_at).toBeNull();
    expect(party!.consent_source).toMatch(/^withdrawn \d{4}-\d\d-\d\d$/);
  });
});

describe('phone numbers and addresses in lists', () => {
  it('are masked for a role without pii:read, in the list and in its download', async () => {
    await (await w.as('admin')).patch(`/api/parties/${id.party}`).send({ billing_address: { line1: '4 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' } }).expect(200);
    const full = (await (await w.as('sales')).get('/api/parties?q=Farah').expect(200)).body.data[0];
    expect(full.phone).toBe('+919811000081');
    const stores = await w.as('stores');
    const masked = (await stores.get('/api/parties?q=Farah').expect(200)).body.data[0];
    expect(masked.phone).toBe(`${'•'.repeat(9)}0081`); // +919811000081: all but the last four digits
    expect(masked.billing_address).toBe('Hidden');
    const csv = (await stores.get('/api/parties?q=Farah&format=csv').expect(200)).text;
    expect(csv).not.toContain('9811000081');
    expect(csv).not.toContain('Lake Road');
  });
});

describe('opening a full record', () => {
  it('is logged for everyone, and only admins and the owner can read the log', async () => {
    const leadId = (await rows<{ id: string }>(w.db, sql`select id from leads where phone = '+919811000082'`))[0]!.id;
    await (await w.as('stores')).get(`/api/parties/${id.party}`).expect(200);
    await (await w.as('sales')).get(`/api/leads/${leadId}`).expect(200);
    await (await w.as('sales')).get('/api/settings/access-log').expect(403);
    const log = (await (await w.as('owner')).get('/api/settings/access-log').expect(200)).body.data;
    expect(log.slice(0, 2).map((r: any) => [r.role, r.record_type, r.record_name])).toEqual([
      ['sales', 'lead', 'Gopal Rao'], ['stores', 'party', 'Farah Khan'],
    ]);
    void m;
  });
});
