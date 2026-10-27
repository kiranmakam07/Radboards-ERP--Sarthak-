import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import express, { Router } from 'express';
import { z } from 'zod';
import { can, type Permission } from '@radcore/shared';
import { config } from '../config';
import { requireAuth } from '../core/auth';
import { rows, type DB } from '../db/client';
import { fileContents, files } from '../db/schema';
import { AppError, badRequest, forbidden, must } from '../lib/errors';
import { zId } from '../lib/http';

/**
 * Attachments. A file is posted as the request body itself (not a form), checked by its first
 * bytes rather than by what the browser says it is, and stored under the upload folder by id
 * (or in the database, where the host has no disk: see config.fileStore).
 * Only PDFs and ordinary pictures are taken: nothing a browser would run as a page.
 */
export const MAX_BYTES = config.maxUploadBytes;

const PURPOSES = ['resume', 'bill', 'item_image', 'share', 'other', 'service', 'delivery'] as const;
type Purpose = (typeof PURPOSES)[number];

/** Who may attach, and who may open, each kind of file. */
const UPLOAD: Record<Purpose, Permission[] | null> = {
  resume: ['hr:write'], bill: ['expenses:write', 'bills:write'], item_image: ['items:write'], share: ['leads:write'], other: null,
  service: ['service:write'],
  // The photo at a vehicle's delivery and the signed delivery note (the delivery checklist).
  delivery: ['sales:write', 'quickbill:create'],
};
const OPEN: Record<Purpose, Permission[] | null> = {
  resume: ['hr:read'], bill: ['expenses:read', 'purchasing:read', 'accounts:read'], item_image: null, share: ['leads:read'], other: null,
  service: ['service:read'],
  delivery: ['sales:read'],
};

/** What the bytes really are, from their signature. Null when it is not a kind we keep. */
export function sniff(buf: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const diskPath = (id: string) => path.join(config.uploadDir, id);
/** A name safe to put in a header and on someone's disk: no paths, no control characters. */
export const safeName = (name: string) => name.replace(/[/\\]/g, '_').replace(/[^\w .()\-]+/g, '_').slice(0, 120) || 'file';

/** A stored file and its bytes, from wherever they are kept. Null when there is no such file. */
export async function readFileBytes(db: DB, id: string): Promise<{ file: typeof files.$inferSelect; bytes: Buffer } | null> {
  const [file] = await db.select().from(files).where(eq(files.id, id));
  if (!file) return null;
  if (fs.existsSync(diskPath(id))) return { file, bytes: fs.readFileSync(diskPath(id)) };
  const [kept] = await db.select({ bytes: fileContents.bytes }).from(fileContents).where(eq(fileContents.fileId, id));
  return kept ? { file, bytes: kept.bytes } : null;
}

export function filesRouter(db: DB) {
  const r = Router();

  r.post('/', requireAuth, express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    const q = z.object({ purpose: z.enum(PURPOSES).prefault('other') }).parse(req.query);
    const allowed = UPLOAD[q.purpose];
    if (allowed && !allowed.some((p) => can(req.user!.role, p))) throw forbidden();
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('No file was sent');
    const mime = sniff(body);
    if (!mime) throw badRequest('Only PDF, JPG, PNG and WEBP files can be attached');
    let name = 'file';
    try {
      name = safeName(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')));
    } catch {
      /* a badly encoded name is not worth refusing the file for */
    }
    const [row] = await db.insert(files).values({
      purpose: q.purpose, originalName: name, mime, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'),
      createdBy: req.user!.id,
    }).returning();
    try {
      if (config.fileStore === 'database') await db.insert(fileContents).values({ fileId: row!.id, bytes: body });
      else {
        fs.mkdirSync(config.uploadDir, { recursive: true });
        fs.writeFileSync(diskPath(row!.id), body, { flag: 'wx' });
      }
    } catch (e) {
      // Without the bytes the row means nothing; take it back out so nothing points at a missing file.
      await db.delete(files).where(eq(files.id, row!.id));
      console.error(e);
      throw new AppError(500, 'storage_error', 'The file could not be saved. Tell an admin: the place files are kept may be full or missing.');
    }
    res.status(201).json({ data: { id: row!.id, url: `/api/files/${row!.id}`, name, mime, size: body.length } });
  });

  r.get('/:id', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    const [f] = await db.select().from(files).where(eq(files.id, id));
    must(f, 'File');
    const allowed = OPEN[f!.purpose as Purpose];
    let ok = !allowed || allowed.some((p) => can(req.user!.role, p)) || f!.createdBy === req.user!.id;
    if (!ok && f!.purpose === 'resume') {
      // Whoever is taking the interview needs the resume, even without access to the rest of HR.
      const [mine] = await rows(db, sql`
        select 1 as x from interviews i join applicants a on a.id = i.applicant_id
         where i.interviewer_id = ${req.user!.id} and i.status = 'scheduled' and a.resume_url = ${`/api/files/${id}`} limit 1`);
      ok = Boolean(mine);
    }
    if (!ok) throw forbidden();
    // Look in both places: a file stays readable if the way files are kept is changed later.
    const [kept] = fs.existsSync(diskPath(id)) ? [] : await db.select({ bytes: fileContents.bytes }).from(fileContents).where(eq(fileContents.fileId, id));
    if (!kept && !fs.existsSync(diskPath(id))) throw must(null, 'File');
    res.setHeader('Content-Type', f!.mime);
    res.setHeader('Content-Length', String(f!.size));
    res.setHeader('Content-Disposition', `inline; filename="${safeName(f!.originalName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (kept) res.end(kept.bytes);
    else fs.createReadStream(diskPath(id)).pipe(res);
  });

  return r;
}
