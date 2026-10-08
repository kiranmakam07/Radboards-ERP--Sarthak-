import { createApp } from './app';
import { config } from './config';
import { createDb } from './db/client';
import { ensureAdmin, seedDefaults } from './db/seed';

const handle = await createDb(config.databaseUrl, config.migrationsFolder);
await seedDefaults(handle.db);
const admin = await ensureAdmin(handle.db);

const app = createApp(handle.db);
const server = app.listen(config.port, () => {
  console.log(`RadCore API on http://localhost:${config.port} (${handle.kind} database, ${config.env})`);
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
