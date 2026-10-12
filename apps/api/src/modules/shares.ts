import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { getCompany } from '../core/settings';
import { requirePerm } from '../core/auth';
import { audit } from '../core/audit';
import { rows, type DB } from '../db/client';
import { files, leadActivities, leadShares, leads } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { inTx, zId, zText } from '../lib/http';
import { readFileBytes, safeName } from './files';

/**
 * A file sent to a lead (a price list, a brochure, a quotation) through a link of its own, so we
 * can see whether they opened it. The link shows a small page; opening that page is what counts
 * as a view, so the preview WhatsApp fetches when the link is pasted does not.
 */

const FILE_URL = /^\/api\/files\/([0-9a-f-]{36})$/i;
// Re-opening within this long is the same look, not another one.
const SAME_LOOK = sql`interval '1 minute'`;

export function sharesRouter(db: DB) {
  const r = Router();

  /** Files sent before, newest first, so a brochure is attached once and reused. */
  r.get('/shared-files', requirePerm('leads:read'), async (_req, res) => {
    res.json({ data: await rows(db, sql`
      select distinct on (s.file_id) s.file_id, s.title, f.mime, s.created_at
        from lead_shares s join files f on f.id = s.file_id order by s.file_id, s.created_at desc limit 50`) });
  });

  r.get('/:id/shares', requirePerm('leads:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    res.json({ data: await rows(db, sql`
      select s.id, s.token, s.title, s.created_at, s.first_viewed_at, s.last_viewed_at, s.view_count, s.revoked_at, u.name as sent_by, f.mime
        from lead_shares s join files f on f.id = s.file_id left join users u on u.id = s.created_by
       where s.lead_id = ${id} order by s.created_at desc`) });
  });

  r.post('/:id/shares', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ title: zText(120), file_url: z.string().regex(FILE_URL, 'attach a file first') }).parse(req.body);
    const fileId = FILE_URL.exec(b.file_url)![1]!;
    const share = await inTx(db, req, async (ctx) => {
      const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, id));
      must(lead, 'Lead');
      const [file] = await ctx.tx.select().from(files).where(eq(files.id, fileId));
      if (!file || file.purpose !== 'share') throw badRequest('That file was not attached for sharing');
      const [row] = await ctx.tx.insert(leadShares).values({
        leadId: id, fileId, title: b.title, token: crypto.randomBytes(16).toString('base64url'), createdBy: ctx.user!.id,
      }).returning();
      await ctx.tx.insert(leadActivities).values({ leadId: id, type: 'note', note: `Sent the file "${b.title}"`, userId: ctx.user!.id });
      await audit(ctx, 'lead_share', row!.id, 'create', null, { lead_id: id, file_id: fileId, title: b.title });
      return { ...row!, phone: lead!.phone, name: lead!.name };
    });
    res.status(201).json({ data: { id: share.id, token: share.token, title: share.title, path: `/s/${share.token}`, phone: share.phone, name: share.name } });
  });

  /** Stop a link working: sent to the wrong person, or the price list is out of date. */
  r.post('/shares/:shareId/revoke', requirePerm('leads:write'), async (req, res) => {
    const shareId = zId.parse(req.params.shareId);
    await inTx(db, req, async (ctx) => {
      const [s] = await ctx.tx.select().from(leadShares).where(eq(leadShares.id, shareId)).for('update');
      must(s, 'Shared file');
      if (s!.revokedAt) throw conflict('This link was already switched off');
      await ctx.tx.update(leadShares).set({ revokedAt: new Date() }).where(eq(leadShares.id, shareId));
      await audit(ctx, 'lead_share', shareId, 'revoke', null, { revoked: true });
    });
    res.json({ ok: true });
  });

  return r;
}

/** What the person with the link sees. No login: the link itself is the key, and says nothing about the lead. */
export function publicSharesRouter(db: DB) {
  const r = Router();
  const live = async (token: string) => {
    const [s] = await db.select().from(leadShares).where(eq(leadShares.token, token));
    if (!s || s.revokedAt) throw must(null, 'This link');
    return s;
  };

  r.get('/:token', async (req, res) => {
    const s = await live(String(req.params.token));
    const [f] = await db.select({ mime: files.mime, size: files.size }).from(files).where(eq(files.id, s.fileId));
    const company = await getCompany(db);
    res.json({ data: { title: s.title, mime: f!.mime, size: f!.size, from: company.name, phone: company.phone ?? null } });
  });

  /** The page calls this once it is on someone's screen. The first look goes on the lead's timeline. */
  r.post('/:token/open', async (req, res) => {
    const token = String(req.params.token);
    await live(token);
    await db.transaction(async (trx) => {
      const tx = trx as unknown as DB;
      const [s] = await tx.select().from(leadShares).where(eq(leadShares.token, token)).for('update');
      if (!s || s.revokedAt) return;
      const [recent] = await rows<{ recent: boolean }>(tx, sql`select (${s.lastViewedAt}::timestamptz > now() - ${SAME_LOOK}) as recent`);
      if (s.lastViewedAt && recent?.recent) return;
      await tx.update(leadShares)
        .set({ viewCount: s.viewCount + 1, lastViewedAt: new Date(), firstViewedAt: s.firstViewedAt ?? new Date() })
        .where(eq(leadShares.id, s.id));
      if (!s.firstViewedAt) {
        await tx.insert(leadActivities).values({ leadId: s.leadId, type: 'note', note: `They opened the file "${s.title}"`, userId: null });
        await tx.update(leads).set({ updatedAt: new Date() }).where(eq(leads.id, s.leadId));
      }
    });
    res.json({ ok: true });
  });

  r.get('/:token/file', async (req, res) => {
    const s = await live(String(req.params.token));
    const found = await readFileBytes(db, s.fileId);
    if (!found) throw must(null, 'The file');
    res.setHeader('Content-Type', found.file.mime);
    res.setHeader('Content-Length', String(found.bytes.length));
    res.setHeader('Content-Disposition', `inline; filename="${safeName(s.title)}${found.file.mime === 'application/pdf' ? '.pdf' : ''}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // helmet's default keeps other sites from embedding our responses; this one is shown on our own share page.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(found.bytes);
  });

  return r;
}
