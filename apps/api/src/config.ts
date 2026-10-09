import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(API_ROOT, '../..');

// Root .env first, then apps/api/.env (neither overrides real environment variables).
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(API_ROOT, '.env'), quiet: true });

const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 4000),
  /**
   * postgres://... -> real PostgreSQL (production / staging).
   * unset          -> embedded PGlite database stored in apps/api/.data (zero-setup local dev).
   * memory://      -> throwaway in-memory database (tests).
   */
  databaseUrl: env.DATABASE_URL ?? `file:${path.join(API_ROOT, '.data', 'pglite')}`,
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 14),
  cookieName: 'rc_session',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3000',
  /** How many reverse proxies sit in front of the API (1 = one proxy such as Caddy, or the Next dev proxy). */
  trustProxy: Number(env.TRUST_PROXY ?? 1),
  migrationsFolder: path.join(API_ROOT, 'drizzle'),
};
