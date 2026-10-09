import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '@radcore/shared';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { createDb, rows, sql, type DbHandle } from '../src/db/client';
import { seedReviewCopy } from '../src/db/demo';
import { seedDefaults } from '../src/db/seed';

// The sample data that the demo and a review copy start with. Loading it here also proves the
// whole seed still runs against the current schema, which nothing else checks.
let handle: DbHandle;
const PASSWORD = 'Review-pass-2026';

beforeAll(async () => {
  handle = await createDb('memory://', config.migrationsFolder);
  await seedDefaults(handle.db);
});
afterAll(async () => {
  delete process.env.DEMO_PASSWORD;
  await handle.close();
});

describe('a review copy', () => {
  it('will not start with a missing, short or well-known password', async () => {
    delete process.env.DEMO_PASSWORD;
    await expect(seedReviewCopy(handle.db)).rejects.toThrow(/at least 10 characters/);
    process.env.DEMO_PASSWORD = 'short';
    await expect(seedReviewCopy(handle.db)).rejects.toThrow(/at least 10 characters/);
    process.env.DEMO_PASSWORD = 'radcore-demo';
    await expect(seedReviewCopy(handle.db)).rejects.toThrow(/at least 10 characters/);
    const [n] = await rows<{ n: number }>(handle.db, sql`select count(*)::int as n from users`);
    expect(n!.n).toBe(0);
  });

  it('loads sample data once into an empty database, with a sign-in for every role', async () => {
    process.env.DEMO_PASSWORD = PASSWORD;
    expect(await seedReviewCopy(handle.db)).toBe('loaded');
    expect(await seedReviewCopy(handle.db)).toBe('already in use'); // a second start changes nothing
    const [counts] = await rows<Record<string, number>>(handle.db, sql`
      select (select count(*) from users)::int as users, (select count(*) from leads)::int as leads, (select count(*) from items)::int as items,
             (select count(*) from employees)::int as employees, (select count(*) from projects)::int as projects,
             (select count(*) from allocations)::int as allocations, (select count(*) from applicants)::int as applicants`);
    expect(counts).toEqual({ users: ROLES.length, leads: 4, items: 6, employees: 5, projects: 2, allocations: 8, applicants: 6 });

    const app = createApp(handle.db);
    await request(app).post('/api/auth/login').send({ identifier: '9000000006', password: 'radcore-demo' }).expect(401);
    const admin = request.agent(app);
    const login = await admin.post('/api/auth/login').send({ identifier: '9000000006', password: PASSWORD }).expect(200);
    expect(login.body).toMatchObject({ user: { role: 'admin' }, sample_data: true });
    expect((await admin.get('/api/auth/me').expect(200)).body.sample_data).toBe(true);
    for (const [i, role] of ROLES.entries()) {
      const res = await request(app).post('/api/auth/login').send({ identifier: `900000000${i}`, password: PASSWORD }).expect(200);
      expect(res.body.user.role).toBe(role);
    }

    // The sample books are sound, and the screens a reviewer opens first have something on them.
    const health = (await admin.get('/api/accounting/reports/integrity').expect(200)).body.data;
    expect(health).toMatchObject({ journal_balanced: true, unbalanced_entries: 0, stock_matches_gl: true });
    const home = (await admin.get('/api/dashboards/overview').expect(200)).body.data;
    expect(home.leads.fresh).toBe(4);
    expect(home.hiring.open_positions).toBe(2);
    expect(home.ops.maintenance_due).toBe(2);
    const board = (await admin.get('/api/ops/resources').expect(200)).body.data;
    expect(board.people).toHaveLength(5);
    expect(board.people.some((p: { load: number[] }) => p.load.some((l) => l > 100))).toBe(true); // the double-booking that shows the alert
  });
});
