import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';
import { createApp, defaultAppDeps } from './app';
import { config } from './config';
import { loadPermissionOverrides } from './core/settings';
import { createDb, isPostgresUrl, type DB } from './db/client';

/**
 * The API as one request handler, for a host that runs it per request instead of as a server
 * (Vercel, where it sits behind the web app's /api route). The database is brought up to date
 * when the app is built (see prepare.ts), not here, so a cold start only has to connect.
 */

/**
 * The host's own framework adds helpers to the request and the response (Next.js sets `query` and
 * `cookies` on one, `status`, `json` and `send` on the other). Sitting on the object itself, they
 * would hide Express's versions of the same names. Take them off, so every route behaves exactly
 * as it does when Express runs as a server.
 */
function unwrap(req: IncomingMessage, res: ServerResponse): void {
  const strip = (obj: object, names: Iterable<string>) => {
    for (const name of names) if (Object.hasOwn(obj, name)) delete (obj as Record<string, unknown>)[name];
  };
  strip(req, [...Object.getOwnPropertyNames(express.request), 'cookies', 'body']);
  strip(res, Object.getOwnPropertyNames(express.response));
}

/**
 * `freshMs`: an admin's permission change is saved in the database, and the other running copies
 * of the API pick it up within this long.
 */
export function makeHandler(start: () => Promise<{ app: Express; db: DB }>, freshMs = 30_000) {
  let ready: Promise<{ app: Express; db: DB }> | undefined;
  let permissionsReadAt = 0;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Nothing is kept from a failed start: the next request tries again from scratch.
      ready ??= start().catch((e: unknown) => {
        ready = undefined;
        throw e;
      });
      const { app, db } = await ready;
      if (Date.now() - permissionsReadAt >= freshMs) {
        await loadPermissionOverrides(db);
        permissionsReadAt = Date.now();
      }
      unwrap(req, res);
      app(req, res);
    } catch (e) {
      console.error(e);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: {
        code: 'unavailable',
        message: isPostgresUrl(config.databaseUrl)
          ? 'The system cannot reach its database just now. Try again in a moment.'
          : 'No database is connected yet. Add a Postgres database to this project (DATABASE_URL), then deploy again.',
      } }));
    }
  };
}

async function start() {
  if (!isPostgresUrl(config.databaseUrl)) throw new Error('DATABASE_URL is not set to a PostgreSQL address');
  // The web app and its /api route share one address, so requests from that address are our own.
  if (!process.env.WEB_ORIGIN) {
    const hosts = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL].filter(Boolean);
    if (hosts.length > 0) config.webOrigin = hosts.map((h) => `https://${h}`).join(',');
  }
  // Few connections per running copy: the host starts more copies under load, and a hosted database caps the total.
  const { db } = await createDb(config.databaseUrl, config.migrationsFolder, { migrate: false, poolSize: 5 });
  // Leads are created before the webhook is answered: nothing is guaranteed to keep running afterwards.
  return { app: createApp(db, { ...defaultAppDeps, awaitProcessing: true }), db };
}

export const handle = makeHandler(start);
