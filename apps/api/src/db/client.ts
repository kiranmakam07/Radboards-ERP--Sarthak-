import fs from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * One database type for the whole app. Both drivers (node-postgres for real PostgreSQL,
 * PGlite for zero-setup dev and tests) and transactions satisfy it, so services never
 * care which one they are running on.
 */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = { db: DB; close: () => Promise<void>; kind: 'postgres' | 'pglite' };

export const isPostgresUrl = (url: string) => /^postgres(ql)?:\/\//.test(url);

/**
 * Open the database and bring it up to date. `migrate: false` skips the update, for a host where
 * that was already done when the app was built; `poolSize` is how many connections to keep.
 */
export async function createDb(url: string, migrationsFolder: string, opts: { migrate?: boolean; poolSize?: number } = {}): Promise<DbHandle> {
  if (isPostgresUrl(url)) {
    const pg = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.Pool({ connectionString: url, max: opts.poolSize ?? 10 });
    const db = drizzle(pool, { schema });
    if (opts.migrate !== false) await migrate(db, { migrationsFolder });
    return { db: db as unknown as DB, close: () => pool.end(), kind: 'postgres' };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (url === 'memory://') client = new PGlite();
  else {
    const dir = url.replace(/^file:/, '');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as DB, close: () => client.close(), kind: 'pglite' };
}

/** Run a raw SQL query and get plain rows back (same shape on both drivers). */
export async function rows<T = Record<string, unknown>>(db: DB, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export { schema, sql };
