// `npm run demo`: the API on a throwaway in-memory database with sample data.
// Everything is lost when the process stops. Never runs in production.
if (process.env.NODE_ENV === 'production') {
  console.error('The demo server is for local trials only and will not start in production.');
  process.exit(1);
}
process.env.DATABASE_URL = 'memory://';
// So the demo can show a statement password being saved. Nothing here outlives the process, and a
// real server is given its own long random APP_SECRET.
process.env.APP_SECRET ??= 'demo-only-not-a-secret-0123456789';

// Imported after the environment is set, because config reads it at import time.
const { createApp } = await import('./app');
const { config } = await import('./config');
const { createDb } = await import('./db/client');
const { seedDefaults } = await import('./db/seed');
const { seedDemo } = await import('./db/demo');

const handle = await createDb('memory://', config.migrationsFolder);
await seedDefaults(handle.db);
await seedDemo(handle.db);
await (await import('./core/settings')).loadPermissionOverrides(handle.db);
createApp(handle.db).listen(config.port, () => {
  console.log(`RadCore DEMO API on http://localhost:${config.port} (in-memory database, sample data)`);
});

export {};
