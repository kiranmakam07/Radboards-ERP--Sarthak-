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
  databaseUrl: env.DATABASE_URL ?? env.POSTGRES_URL ?? `file:${path.join(API_ROOT, '.data', 'pglite')}`,
  /**
   * A connection that does not go through a pooler, for migrations. Hosted databases such as Neon
   * give two addresses; where there is only one, it is the same as databaseUrl.
   */
  directDatabaseUrl: env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? env.DATABASE_URL ?? env.POSTGRES_URL ?? '',
  /** True on a host that runs the API once per request instead of as a server (Vercel). */
  serverless: Boolean(env.VERCEL),
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 14),
  cookieName: 'rc_session',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3000',
  /** How many reverse proxies sit in front of the API (1 = one proxy such as Caddy, or the Next dev proxy). */
  trustProxy: Number(env.TRUST_PROXY ?? 1),
  migrationsFolder: path.join(API_ROOT, 'drizzle'),
  /** Where attached files (resumes, bill photos, item pictures) are kept. On a server this is a volume of its own. */
  uploadDir: env.UPLOAD_DIR ?? path.join(API_ROOT, '.data', 'uploads'),
  /**
   * 'disk' keeps attached files in uploadDir; 'database' keeps them in the database, for hosts
   * with no disk of their own (Vercel). Such hosts also cap the size of a request, hence the limit.
   */
  fileStore: (env.FILE_STORE ?? (env.VERCEL ? 'database' : 'disk')) as 'disk' | 'database',
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? (env.VERCEL ? 4 : 10)) * 1024 * 1024,
  /**
   * Lead capture from Meta (Facebook / Instagram lead ads and WhatsApp Business). All blank until
   * the accounts are connected; while blank, those webhooks refuse everything.
   * - app secret: signs every webhook Meta sends, so nobody else can post fake leads
   * - verify token: any long random string; typed once into Meta when subscribing the webhook
   * - page access token: lets us read the answers of a lead form (Meta's webhook only carries its id)
   */
  metaAppSecret: env.META_APP_SECRET ?? '',
  metaVerifyToken: env.META_VERIFY_TOKEN ?? '',
  metaPageAccessToken: env.META_PAGE_ACCESS_TOKEN ?? '',
  metaGraphVersion: env.META_GRAPH_VERSION ?? 'v21.0',
  /**
   * Sending WhatsApp messages from inside the app (WhatsApp Cloud API). The number id is shown
   * beside the business number in Meta's WhatsApp > API setup; the token is a permanent system
   * user token with whatsapp_business_messaging. Both blank = replies go out from the person's
   * own WhatsApp instead, as before.
   */
  whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
  /** Shopify signs every webhook with this (Settings > Notifications > Webhooks in the Shopify admin). Blank = not connected. */
  shopifyWebhookSecret: env.SHOPIFY_WEBHOOK_SECRET ?? '',
  /**
   * "Are you a person?" check on the public enquiry form (Cloudflare Turnstile). Blank = no check,
   * and the form relies on its hidden trap field and rate limit alone.
   */
  turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
  turnstileSecret: env.TURNSTILE_SECRET ?? '',
};
