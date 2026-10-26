import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * The settings the running API takes from the environment, read once, in one place. A blank value
 * always means "this feature is off", never "use some default account".
 * What each one is for, and what to put in it, is in .env.example and .env.production.example.
 *
 * The few environment variables read elsewhere are start-up switches, not settings of the running
 * API: SEED_DEMO_DATA and DEMO_PASSWORD (db/demo.ts, server.ts, prepare.ts), SEED_ADMIN_* (db/seed.ts)
 * and BCRYPT_ROUNDS (core/auth.ts, lowered by the tests).
 */

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
  /**
   * Least privilege (brief P3): the database owner's address, used only to apply migrations at start.
   * When set, the API itself connects with DATABASE_URL as a user that can read and write rows but
   * cannot drop or alter anything (deploy/db-app-user.sh makes it). Unset: one user does both.
   */
  migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? '',
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
  /**
   * A long random text (24 characters or more) that locks the secrets kept in the database, such
   * as a bank statement's password. Blank = such secrets cannot be saved, only typed each time.
   * Changing it later makes the saved ones unreadable; they are then entered again.
   */
  appSecret: env.APP_SECRET ?? '',
  /**
   * The mailbox bank statements are forwarded to, read over IMAP. Give it a mailbox of its own
   * and an app password, not a person's mailbox. All blank = statements are uploaded by hand.
   * - cron secret: lets a scheduler ask for the mailbox to be checked (see the README)
   */
  bankMailHost: env.BANK_MAIL_HOST ?? '',
  bankMailPort: Number(env.BANK_MAIL_PORT ?? 993),
  bankMailUser: env.BANK_MAIL_USER ?? '',
  bankMailPassword: env.BANK_MAIL_PASSWORD ?? '',
  bankMailFolder: env.BANK_MAIL_FOLDER ?? 'INBOX',
  bankMailCronSecret: env.BANK_MAIL_CRON_SECRET ?? env.CRON_SECRET ?? '',
  /** Shopify signs every webhook with this (Settings > Notifications > Webhooks in the Shopify admin). Blank = not connected. */
  shopifyWebhookSecret: env.SHOPIFY_WEBHOOK_SECRET ?? '',
  /**
   * "Are you a person?" check on the public enquiry form (Cloudflare Turnstile). Blank = no check,
   * and the form relies on its hidden trap field and rate limit alone.
   */
  turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
  turnstileSecret: env.TURNSTILE_SECRET ?? '',
};
