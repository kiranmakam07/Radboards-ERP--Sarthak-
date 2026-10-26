import crypto from 'node:crypto';
import request from 'supertest';
import { ROLES, gstinCheckChar, type Role } from '@radcore/shared';
import { createApp, type AppDeps } from '../src/app';
import type { CrmDeps } from '../src/modules/crm';
import { config } from '../src/config';
import { hashPassword } from '../src/core/auth';
import { setSetting } from '../src/core/settings';
import { createDb, rows, sql, type DB } from '../src/db/client';
import { seedDefaults } from '../src/db/seed';
import { users } from '../src/db/schema';

export const PASSWORD = 'Test-pass-1234';
export const phoneOf = (role: Role) => `+9190000000${String(ROLES.indexOf(role)).padStart(2, '0')}`;

/** A GSTIN with a correct checksum for the given state code. */
export const gstin = (state: string, pan = 'ABCDE1234F') => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

export type Agent = ReturnType<typeof request.agent>;

/**
 * Where the tests run. By default each test file gets a throwaway in-memory database (PGlite).
 * With TEST_DATABASE_URL set to a real PostgreSQL server (any database on it, e.g.
 * postgres://postgres@localhost:5432/postgres), each test file gets its own freshly created
 * database on that server instead, which is dropped afterwards. CI runs the suite both ways.
 */
export const REAL_POSTGRES = Boolean(process.env.TEST_DATABASE_URL);

async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (!serverUrl) return { url: 'memory://', drop: async () => {} };
  const pg = (await import('pg')).default;
  const name = `rc_test_${crypto.randomBytes(6).toString('hex')}`;
  const run = async (statement: string) => {
    const client = new pg.Client({ connectionString: serverUrl });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  await run(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => run(`drop database if exists ${name} with (force)`) };
}

/**
 * Fresh database with defaults, one user per role, and the company set to Maharashtra (27).
 * Tests never reach the internet: `getJson` stands in for Meta's Graph API, and webhooks answer
 * only after the lead has been created so a test can check for it straight away.
 */
export async function setup(
  getJson: CrmDeps['getJson'] = async () => { throw new Error('no network in tests'); },
  postJson: NonNullable<CrmDeps['postJson']> = async () => { throw new Error('no network in tests'); },
  /** Stands in for the statements mailbox; with none given, no mailbox is connected. */
  readMailbox?: AppDeps['readMailbox'],
) {
  const database = await freshDatabase();
  const handle = await createDb(database.url, config.migrationsFolder);
  const db = handle.db;
  await seedDefaults(db);
  const hash = await hashPassword(PASSWORD);
  await db.insert(users).values(ROLES.map((role) => ({ name: `${role} user`, phone: phoneOf(role), passwordHash: hash, role })));
  await setSetting(db, 'company', {
    name: 'Radboards Pvt Ltd', gstin: gstin('27', 'AAPFU0939F'), state_code: '27',
    address: { line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  }, null);

  const app = createApp(db, { getJson, postJson, awaitProcessing: true, readMailbox });
  const agents = new Map<Role, Agent>();
  const as = async (role: Role): Promise<Agent> => {
    const cached = agents.get(role);
    if (cached) return cached;
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ identifier: phoneOf(role), password: PASSWORD }).expect(200);
    agents.set(role, agent);
    return agent;
  };
  const close = async () => {
    await handle.close();
    await database.drop();
  };
  return { app, db, as, close };
}

export type World = Awaited<ReturnType<typeof setup>>;

export async function masters(db: DB) {
  const loc = await rows<{ id: string; type: string }>(db, sql`select id, type from locations`);
  const acc = await rows<{ id: string; system_key: string }>(db, sql`select id, system_key from accounts where system_key is not null`);
  const src = await rows<{ id: string; name: string }>(db, sql`select id, name from lead_sources`);
  const lost = await rows<{ id: string; name: string }>(db, sql`select id, name from lost_reasons`);
  const cat = await rows<{ id: string; name: string }>(db, sql`select id, name from expense_categories`);
  return {
    stores: loc.find((l) => l.type === 'stores')!.id,
    showroom: loc.find((l) => l.type === 'showroom')!.id,
    rejected: loc.find((l) => l.type === 'rejected')!.id,
    account: (key: string) => acc.find((a) => a.system_key === key)!.id,
    source: (name: string) => src.find((s) => s.name === name)!.id,
    lostReason: (name: string) => lost.find((s) => s.name === name)!.id,
    expenseCategory: (name: string) => cat.find((s) => s.name === name)!.id,
  };
}

/** Put stock on the shelf the proper way: an opening adjustment raised by stores and approved by admin. */
export async function openingStock(w: World, locationId: string, lines: { item_id: string; qty_change: string; unit_cost: string }[]) {
  const stores = await w.as('stores');
  const admin = await w.as('admin');
  const adj = await stores.post('/api/stock/adjustments').send({ kind: 'opening', location_id: locationId, reason: 'Opening stock', lines }).expect(201);
  await admin.post(`/api/stock/adjustments/${adj.body.data.id}/approve`).send({}).expect(200);
}

export async function onHand(db: DB, itemId: string, locationId: string): Promise<number> {
  const [r] = await rows<{ q: string }>(db, sql`select coalesce(sum(qty), 0)::text as q from stock_movements where item_id = ${itemId} and location_id = ${locationId}`);
  return Number(r!.q);
}

/** The books must always be internally consistent, whatever a test just did. */
export async function expectBooksHealthy(w: World) {
  const accounts = await w.as('accounts');
  const res = await accounts.get('/api/accounting/reports/integrity').expect(200);
  const d = res.body.data;
  if (!d.journal_balanced || d.unbalanced_entries !== 0 || !d.stock_matches_gl) {
    throw new Error(`Books are inconsistent: ${JSON.stringify(d)}`);
  }
  const tb = await accounts.get('/api/accounting/reports/trial-balance').expect(200);
  if (!tb.body.balanced) throw new Error('Trial balance does not balance');
  const bs = await accounts.get('/api/accounting/reports/balance-sheet').expect(200);
  if (!bs.body.balanced) throw new Error(`Balance sheet does not balance: ${JSON.stringify(bs.body)}`);
  return d;
}

/** A tiny PNG, for anything that needs a photo attached. */
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b60000000049454e44ae426082', 'hex');

/**
 * A vehicle's delivery checklist, done: the three ticks and two photos (the delivery photo and the signed note)
 * uploaded by `role`. Sent with a quick bill, or saved on an order before it is delivered.
 */
export async function deliveryChecksDone(w: World, role: Role = 'store') {
  const agent = await w.as(role);
  const upload = async (name: string) => (await agent.post('/api/files?purpose=delivery').set('Content-Type', 'image/png').set('X-File-Name', name).send(PNG).expect(201)).body.data.id as string;
  return { pdi_done: true, rider_briefing: true, warranty_registered: true, photo_file_id: await upload('handover.png'), signed_note_file_id: await upload('note.png') };
}
