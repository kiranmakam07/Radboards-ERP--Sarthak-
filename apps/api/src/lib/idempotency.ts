import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { rows, type DB } from '../db/client';
import { badRequest, conflict } from './errors';

/**
 * A save sent twice is done once (technical review, 26 Oct 2026: "a double click can save a payment twice").
 *
 * The screens send an `Idempotency-Key` header with each save, the same key for every attempt of that one save: a
 * second click, or a retry after the answer was lost on a bad connection (apps/web/lib/api.ts). The first request
 * with a key does the work, and its answer is kept for a day (table idempotency_keys). A repeat gets that same
 * answer back and nothing is saved again; a repeat that arrives while the first is still running is told to wait.
 * A request that was refused (an error) keeps nothing, so the corrected save can go with the same key.
 *
 * Requests without the header (scripts, tests, the webhooks) work as before.
 */
const KEY = /^[A-Za-z0-9_-]{16,100}$/;
/** A claim with no answer after this long belongs to a request that died; the key can be used again. */
const STALE_MS = 10 * 60_000;

export function idempotent(db: DB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('Idempotency-Key');
    if (!key || req.method === 'GET' || req.method === 'HEAD' || !req.user) return next();
    if (!KEY.test(key)) throw badRequest('Idempotency-Key must be 16 to 100 letters, digits, - or _');
    const userId = req.user.id;
    const path = req.originalUrl.slice(0, 500);

    const claimed = await rows(db, sql`
      insert into idempotency_keys (key, user_id, method, path) values (${key}, ${userId}, ${req.method}, ${path})
      on conflict (key) do nothing returning key`);
    if (claimed.length === 0) {
      const [prev] = await rows<{ user_id: string; method: string; path: string; status_code: number | null; response: unknown; age_ms: number }>(db, sql`
        select user_id, method, path, status_code, response, (extract(epoch from now() - created_at) * 1000)::float8 as age_ms
          from idempotency_keys where key = ${key}`);
      if (!prev) return next(); // let go between the two statements: nothing to repeat
      if (prev.user_id !== userId || prev.method !== req.method || prev.path !== path) {
        throw conflict('This save key was already used for a different request');
      }
      if (prev.status_code === null) {
        if (prev.age_ms < STALE_MS) throw conflict('This is already being saved. Wait a moment, then look again before trying once more.');
        await rows(db, sql`delete from idempotency_keys where key = ${key} and status_code is null`);
        return next();
      }
      res.setHeader('Idempotent-Replay', 'true');
      res.status(prev.status_code).json(prev.response);
      return;
    }
    // Now and then, forget keys older than a day.
    if (Math.random() < 0.02) await rows(db, sql`delete from idempotency_keys where created_at < now() - interval '1 day'`);

    // Keep the answer before it goes out, so a repeat that follows straight after already finds it.
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const keep = status < 400
        ? rows(db, sql`update idempotency_keys set status_code = ${status},
            response = ${JSON.stringify(body ?? null, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}::jsonb where key = ${key}`)
        : rows(db, sql`delete from idempotency_keys where key = ${key}`);
      keep.catch((e: unknown) => console.error('idempotency: could not keep the answer', e)).finally(() => send(body));
      return res;
    };
    // A file, or a response that never went through res.json: the key is let go.
    res.on('finish', () => {
      if (res.getHeader('Content-Type')?.toString().includes('application/json')) return;
      rows(db, sql`delete from idempotency_keys where key = ${key} and status_code is null`).catch(() => undefined);
    });
    next();
  };
}
