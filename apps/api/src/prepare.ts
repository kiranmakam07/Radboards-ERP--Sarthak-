import { config } from './config';
import { createDb, isPostgresUrl } from './db/client';
import { seedReviewCopy } from './db/demo';
import { ensureAdmin, seedDefaults } from './db/seed';

/**
 * What server.ts does before it starts listening, as a step of its own: bring the database up to
 * date and load what a new installation needs. Run while the app is built on a host that has no
 * long-running server to do it at start (Vercel): `npm run prepare:db -w @radcore/api`.
 */
const url = config.directDatabaseUrl;
if (!isPostgresUrl(url)) {
  // Not an error: the first build of a new project happens before its database is added.
  console.warn('\nNo database is connected yet (DATABASE_URL is not set), so nothing was prepared.');
  console.warn('Add a Postgres database to the project, then build again.\n');
} else {
  const handle = await createDb(url, config.migrationsFolder, { poolSize: 2 });
  await seedDefaults(handle.db);
  if (process.env.SEED_DEMO_DATA === 'true') {
    const review = await seedReviewCopy(handle.db);
    console.log(review === 'loaded'
      ? 'Review copy: sample data loaded. Sign in with phone 9000000006 (admin) and DEMO_PASSWORD.'
      : 'Database is up to date (it already has users, so no sample data was loaded).');
  } else {
    const admin = await ensureAdmin(handle.db);
    if (admin) {
      console.log('\nFirst admin user created. Sign in and change the password:');
      console.log(`  phone:    ${admin.phone}`);
      console.log(`  password: ${admin.password}\n`);
    } else console.log('Database is up to date.');
  }
  await handle.close();
}
