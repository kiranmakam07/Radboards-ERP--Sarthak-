import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import { masters, setup, type World } from './helpers';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let dir: string;
const original = config.uploadDir;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');

const attach = async (role: Parameters<World['as']>[0], purpose: string) =>
  (await w.as(role)).post(`/api/files?purpose=${purpose}`).set('Content-Type', 'application/pdf').set('X-File-Name', 'price-list.pdf').send(PDF);
const share = async (leadId: string) =>
  (await rows<Record<string, any>>(w.db, sql`select * from lead_shares where lead_id = ${leadId} order by created_at desc limit 1`))[0] as Record<string, any>;
const notes = async (leadId: string) =>
  (await rows<{ note: string; user_id: string | null }>(w.db, sql`select note, user_id from lead_activities where lead_id = ${leadId} and type = 'note' order by at`)).map((a) => a.note);

beforeAll(async () => {
  w = await setup();
  m = await masters(w.db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-shares-'));
  config.uploadDir = dir;
});
afterAll(async () => {
  config.uploadDir = original;
  fs.rmSync(dir, { recursive: true, force: true });
  await w.close();
});

describe('a file sent to a lead', () => {
  let leadId: string;
  let token: string;
  let fileUrl: string;
  let since: string;

  it('gets a link of its own, and the sending goes on the lead’s timeline', async () => {
    const sales = await w.as('sales');
    since = (await sales.get('/api/leads/alerts').expect(200)).body.now;
    leadId = (await sales.post('/api/leads').send({ name: 'Asha Rao', phone: '9820011111', source_id: m.source('Website') }).expect(201)).body.data.id;
    expect((await attach('hr', 'share')).status).toBe(403); // sharing is for the people who work leads
    fileUrl = (await attach('sales', 'share')).body.data.url;

    const made = await sales.post(`/api/leads/${leadId}/shares`).send({ title: 'Price list, October', file_url: fileUrl }).expect(201);
    token = made.body.data.token;
    expect(made.body.data).toMatchObject({ title: 'Price list, October', path: `/s/${token}`, phone: '+919820011111', name: 'Asha Rao' });
    expect(token.length).toBeGreaterThanOrEqual(20);
    expect(await notes(leadId)).toContain('Sent the file "Price list, October"');

    // Only a file attached for sharing can be sent: not someone's bill, and not an address made up by hand.
    const bill = (await attach('accounts', 'bill')).body.data.url;
    await sales.post(`/api/leads/${leadId}/shares`).send({ title: 'A bill', file_url: bill }).expect(400);
    await sales.post(`/api/leads/${leadId}/shares`).send({ title: 'Elsewhere', file_url: 'https://example.com/x.pdf' }).expect(400);
    await sales.post(`/api/leads/${leadId}/shares`).send({ title: '', file_url: fileUrl }).expect(400);
    await (await w.as('hr')).post(`/api/leads/${leadId}/shares`).send({ title: 'x', file_url: fileUrl }).expect(403);
  });

  it('can be opened by whoever has the link, without signing in, and tells them nothing about the lead', async () => {
    const meta = await request(w.app).get(`/api/public/shares/${token}`).expect(200);
    expect(meta.body.data).toEqual({ title: 'Price list, October', mime: 'application/pdf', size: PDF.length, from: 'Radboards Pvt Ltd', phone: null });
    const file = await request(w.app).get(`/api/public/shares/${token}/file`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((file.body as Buffer).equals(PDF)).toBe(true);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('inline; filename="Price list_ October.pdf"');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    await request(w.app).get('/api/public/shares/not-a-real-token').expect(404);
    // The file itself, by its own address, still needs a sign-in.
    await request(w.app).get(fileUrl).expect(401);
  });

  it('counts as opened when the page is on a screen, not when a chat app fetches a preview', async () => {
    // Fetching the details or the file (which is all a link preview does) is not a look.
    expect(await share(leadId)).toMatchObject({ view_count: 0, first_viewed_at: null });

    await request(w.app).post(`/api/public/shares/${token}/open`).send({}).expect(200);
    const first = await share(leadId);
    expect(first.view_count).toBe(1);
    expect(first.first_viewed_at).toBeTruthy();
    expect(await notes(leadId)).toContain('They opened the file "Price list, October"');

    // A refresh a few seconds later is the same look.
    await request(w.app).post(`/api/public/shares/${token}/open`).send({}).expect(200);
    expect((await share(leadId)).view_count).toBe(1);
    // Coming back later is another one, but the timeline is told only the first time.
    await rows(w.db, sql`update lead_shares set last_viewed_at = now() - interval '5 minutes' where token = ${token}`);
    await request(w.app).post(`/api/public/shares/${token}/open`).send({}).expect(200);
    const again = await share(leadId);
    expect(again.view_count).toBe(2);
    expect(String(again.first_viewed_at)).toBe(String(first.first_viewed_at));
    expect((await notes(leadId)).filter((n) => n.startsWith('They opened'))).toHaveLength(1);

    const list = (await (await w.as('sales')).get(`/api/leads/${leadId}/shares`).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Price list, October', view_count: 2, sent_by: 'sales user', revoked_at: null });
  });

  it('tells the person who sent it, the moment it is first opened', async () => {
    const sales = await w.as('sales');
    const told = (await sales.get(`/api/leads/alerts?since=${encodeURIComponent(since)}`).expect(200)).body;
    expect(told.opened).toHaveLength(1);
    expect(told.opened[0]).toMatchObject({ title: 'Price list, October', name: 'Asha Rao', lead_id: leadId });
    expect((await sales.get(`/api/leads/alerts?since=${encodeURIComponent(told.now)}`).expect(200)).body.opened).toHaveLength(0);
    // Someone who neither owns the lead nor sent the file is not told.
    expect((await (await w.as('store')).get(`/api/leads/alerts?since=${encodeURIComponent(since)}`).expect(200)).body.opened).toHaveLength(0);
  });

  it('can be sent again to someone else without attaching it twice, and switched off', async () => {
    const sales = await w.as('sales');
    const earlier = (await sales.get('/api/leads/shared-files').expect(200)).body.data;
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).toMatchObject({ title: 'Price list, October', mime: 'application/pdf' });
    const other = (await sales.post('/api/leads').send({ name: 'Vikram Shah', phone: '9820022222', source_id: m.source('Website') }).expect(201)).body.data.id;
    const second = (await sales.post(`/api/leads/${other}/shares`).send({ title: earlier[0].title, file_url: `/api/files/${earlier[0].file_id}` }).expect(201)).body.data;
    expect(second.token).not.toBe(token); // each lead has a link of their own, so we know who opened it

    const mine = await share(leadId);
    await sales.post(`/api/leads/shares/${mine.id}/revoke`).send({}).expect(200);
    await sales.post(`/api/leads/shares/${mine.id}/revoke`).send({}).expect(409);
    await request(w.app).get(`/api/public/shares/${token}`).expect(404);
    await request(w.app).get(`/api/public/shares/${token}/file`).expect(404);
    await request(w.app).post(`/api/public/shares/${token}/open`).send({}).expect(404);
    expect((await share(leadId)).view_count).toBe(2);
    // The other lead's link is untouched.
    await request(w.app).get(`/api/public/shares/${second.token}`).expect(200);
  });
});
