import { createApp } from './app';
import { config } from './config';
import { loadPermissionOverrides } from './core/settings';
import { createDb, isPostgresUrl, type DbHandle } from './db/client';
import { seedReviewCopy } from './db/demo';
import { ensureAdmin, seedDefaults } from './db/seed';

/**
 * `npm run dev` and `npm start`: the API as a long-running server. It opens the database (applying
 * any migration not yet applied), loads what a new installation needs, and listens.
 *
 * Where there is no long-running server (Vercel) the same steps are split in two: prepare.ts does
 * the database part once, when the app is built, and serverless.ts answers the requests.
 */

// On a real server the books must be in PostgreSQL. Without DATABASE_URL the API would otherwise
// start on a file database inside the container, and the first restart from a new image loses it.
if (config.isProd && !isPostgresUrl(config.databaseUrl)) {
  console.error('DATABASE_URL is not set to a PostgreSQL address (postgres://...). Refusing to start in production without one.');
  process.exit(1);
}

// Migrations change the tables, so with a separate owner login they run as the owner, and the API then
// works as a user that can only read and write rows (brief P3, least privilege).
let handle: DbHandle;
if (isPostgresUrl(config.migrationDatabaseUrl)) {
  const owner = await createDb(config.migrationDatabaseUrl, config.migrationsFolder, { poolSize: 1 });
  await owner.close();
  handle = await createDb(config.databaseUrl, config.migrationsFolder, { migrate: false });
} else {
  handle = await createDb(config.databaseUrl, config.migrationsFolder);
}
await seedDefaults(handle.db);
await loadPermissionOverrides(handle.db);
// A review copy starts with sample data and its own sign-ins instead of a single empty admin.
const review = process.env.SEED_DEMO_DATA === 'true' ? await seedReviewCopy(handle.db) : null;
const admin = review ? null : await ensureAdmin(handle.db);

const app = createApp(handle.db);
const server = app.listen(config.port, () => {
  console.log(`RadCore API on http://localhost:${config.port} (${handle.kind} database, ${config.env})`);
  if (review === 'loaded') console.log('Review copy: sample data loaded. Sign in with phone 9000000006 (admin) and DEMO_PASSWORD.');
  if (admin) {
    console.log('\nFirst admin user created. Sign in and change the password:');
    console.log(`  phone:    ${admin.phone}`);
    console.log(`  password: ${admin.password}\n`);
  }
});

// The web app passes requests on to this server over connections it keeps open between requests.
// Node closes an idle one after 5 seconds; if the web app picks it up again at that very moment the
// request fails ("ECONNRESET"). Keeping them longer than the web app does leaves the closing to it.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function shutdown() {
  server.close();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
