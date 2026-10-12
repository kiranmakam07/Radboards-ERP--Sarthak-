import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { MAX_BYTES, sniff } from '../src/modules/files';
import { rows, sql } from '../src/db/client';
import { setup, type World } from './helpers';

let w: World;
let dir: string;
const original = config.uploadDir;

// The smallest real files of each kind: enough for the signature check.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a tiny png')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const send = async (role: Parameters<World['as']>[0], purpose: string, body: Buffer, name = 'file.bin', type = 'application/octet-stream') =>
  (await w.as(role)).post(`/api/files?purpose=${purpose}`).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(body);
/** Fetch a file back as raw bytes. */
const fetchBytes = async (role: Parameters<World['as']>[0], url: string) =>
  (await w.as(role)).get(url).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  w = await setup();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-uploads-'));
  config.uploadDir = dir;
});
afterAll(async () => {
  config.uploadDir = original;
  fs.rmSync(dir, { recursive: true, force: true });
  await w.close();
});

describe('attached files', () => {
  it('tells a file by its first bytes, not by its name', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(PDF)).toBe('application/pdf');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniff(HTML)).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });

  it('keeps a file and gives exactly the same bytes back', async () => {
    const up = await send('accounts', 'bill', PDF, 'Rent bill (Oct).pdf', 'application/pdf');
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ name: 'Rent bill (Oct).pdf', mime: 'application/pdf', size: PDF.length });
    expect(up.body.data.url).toBe(`/api/files/${up.body.data.id}`);
    expect(fs.readFileSync(path.join(dir, up.body.data.id)).equals(PDF)).toBe(true);

    const back = await fetchBytes('accounts', up.body.data.url);
    expect(back.status).toBe(200);
    expect((back.body as Buffer).equals(PDF)).toBe(true);
    expect(back.headers['content-type']).toBe('application/pdf');
    expect(back.headers['content-disposition']).toBe('inline; filename="Rent bill (Oct).pdf"');
    expect(back.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses anything that is not a PDF or a picture, whatever it calls itself', async () => {
    expect((await send('accounts', 'bill', HTML, 'bill.pdf', 'application/pdf')).status).toBe(400);
    expect((await send('accounts', 'bill', HTML, 'photo.png', 'image/png')).status).toBe(400);
    expect((await send('accounts', 'bill', Buffer.alloc(0), 'empty.pdf', 'application/pdf')).status).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_BYTES)]);
    expect((await send('accounts', 'bill', big, 'huge.pdf', 'application/pdf')).status).toBe(413);
    expect((await send('accounts', 'nonsense', PDF)).status).toBe(400);
    expect(fs.readdirSync(dir)).toHaveLength(1); // only the one good file from before is on disk
    const [n] = await rows<{ n: number }>(w.db, sql`select count(*)::int as n from files`);
    expect(n!.n).toBe(1);
  });

  it('is kept away from a path someone might try to smuggle in through the name', async () => {
    const up = await send('accounts', 'bill', PNG, '../../etc/passwd<script>.png', 'image/png');
    expect(up.status).toBe(201);
    expect(up.body.data.name).not.toMatch(/[/\\<>]/);
    expect(fs.existsSync(path.join(dir, up.body.data.id))).toBe(true); // stored under its id, nowhere else
    await (await w.as('accounts')).get('/api/files/..%2F..%2Fetc%2Fpasswd').expect(400);
  });

  it('lets each kind of file be attached and opened only by the people it is for', async () => {
    await request(w.app).post('/api/files?purpose=bill').set('Content-Type', 'application/pdf').send(PDF).expect(401);
    expect((await send('sales', 'resume', PDF)).status).toBe(403);
    expect((await send('sales', 'bill', PDF)).status).toBe(403);
    const resume = await send('hr', 'resume', PDF, 'Priya Nair.pdf', 'application/pdf');
    expect(resume.status).toBe(201);

    await (await w.as('owner')).get(resume.body.data.url).expect(200); // the owner can see HR
    await (await w.as('sales')).get(resume.body.data.url).expect(403);
    await (await w.as('accounts')).get(resume.body.data.url).expect(403);
    await request(w.app).get(resume.body.data.url).expect(401);

    // Put it on an applicant and book the sales user to interview her: now the interviewer can open it.
    const hr = await w.as('hr');
    const applicant = await hr.post('/api/hr/applicants').send({ name: 'Priya Nair', phone: '9820011111', source: 'job_portal', resume_url: resume.body.data.url }).expect(201);
    expect(applicant.body.data.resume_url).toBe(resume.body.data.url);
    const [salesUser] = await rows<{ id: string }>(w.db, sql`select id from users where role = 'sales'`);
    await hr.post(`/api/hr/applicants/${applicant.body.data.id}/interviews`).send({ title: 'Manager round', scheduled_at: new Date(Date.now() + 86400_000).toISOString(), interviewer_id: salesUser!.id }).expect(201);
    await (await w.as('sales')).get(resume.body.data.url).expect(200);
    await (await w.as('store')).get(resume.body.data.url).expect(403);

    // A plain web link is still accepted where a file can go; a script link never is.
    await hr.patch(`/api/hr/applicants/${applicant.body.data.id}`).send({ resume_url: 'https://example.com/cv.pdf' }).expect(200);
    await hr.patch(`/api/hr/applicants/${applicant.body.data.id}`).send({ resume_url: 'javascript:alert(1)' }).expect(400);
    await hr.patch(`/api/hr/applicants/${applicant.body.data.id}`).send({ resume_url: '/api/files/not-an-id' }).expect(400);
    await (await w.as('owner')).get('/api/files/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('puts pictures on an item, shows the first one in the list, and takes one off again', async () => {
    const admin = await w.as('admin');
    const item = (await admin.post('/api/items').send({ sku: 'PIC-1', name: 'Pictured board', item_type: 'finished_good', hsn_sac: '950699', gst_rate: 18 }).expect(201)).body.data;
    const front = (await send('admin', 'item_image', PNG, 'front.png', 'image/png')).body.data;
    const side = (await send('admin', 'item_image', PNG, 'side.png', 'image/png')).body.data;
    expect((await send('sales', 'item_image', PNG)).status).toBe(403); // adding pictures is for whoever keeps the item list
    const first = (await admin.post(`/api/items/${item.id}/images`).send({ url: front.url, sort: 0 }).expect(201)).body.data;
    await admin.post(`/api/items/${item.id}/images`).send({ url: side.url, sort: 1 }).expect(201);
    await admin.post(`/api/items/${item.id}/images`).send({ url: 'javascript:alert(1)' }).expect(400);
    await admin.post('/api/items/00000000-0000-4000-8000-000000000000/images').send({ url: front.url }).expect(404);

    const sales = await w.as('sales');
    expect((await sales.get(`/api/items/${item.id}/images`).expect(200)).body.data.map((p: any) => p.url)).toEqual([front.url, side.url]);
    const listed = (await sales.get('/api/items?q=PIC-1').expect(200)).body.data[0];
    expect(listed.image_url).toBe(front.url);
    await sales.get(front.url).expect(200); // anyone signed in can look at an item's picture
    await sales.delete(`/api/items/${item.id}/images/${first.id}`).expect(403);

    await admin.delete(`/api/items/${item.id}/images/${first.id}`).expect(200);
    await admin.delete(`/api/items/${item.id}/images/${first.id}`).expect(404);
    expect((await sales.get('/api/items?q=PIC-1').expect(200)).body.data[0].image_url).toBe(side.url);
  });

  it('can keep files in the database instead, for a host with no disk of its own', async () => {
    const before = fs.readdirSync(dir).length;
    config.fileStore = 'database';
    try {
      const up = await send('accounts', 'bill', PNG, 'Courier bill.png', 'image/png');
      expect(up.status).toBe(201);
      expect(fs.readdirSync(dir)).toHaveLength(before); // nothing new on disk
      const [kept] = await rows<{ n: number }>(w.db, sql`select octet_length(bytes)::int as n from file_contents where file_id = ${up.body.data.id}`);
      expect(kept!.n).toBe(PNG.length);

      const back = await fetchBytes('accounts', up.body.data.url);
      expect(back.status).toBe(200);
      expect((back.body as Buffer).equals(PNG)).toBe(true);
      expect(back.headers['content-type']).toBe('image/png');
      await (await w.as('sales')).get(up.body.data.url).expect(403); // the same rules about who may open it
      expect((await send('accounts', 'bill', HTML, 'bill.pdf', 'application/pdf')).status).toBe(400);
    } finally {
      config.fileStore = 'disk';
    }
    // Files attached while they were kept on disk are still found there.
    const old = await rows<{ id: string }>(w.db, sql`select id from files where purpose = 'bill' and original_name = 'Rent bill (Oct).pdf'`);
    await (await w.as('accounts')).get(`/api/files/${old[0]!.id}`).expect(200);
  });
});
