import { createApp } from './app';
import { config } from './config';
import { loadPermissionOverrides } from './core/settings';
import { createDb } from './db/client';
import { seedReviewCopy } from './db/demo';
import { ensureAdmin, seedDefaults } from './db/seed';

const handle = await createDb(config.databaseUrl, config.migrationsFolder);
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

async function shutdown() {
  server.close();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
