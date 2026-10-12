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
  // A hosted database that has been idle is asleep and takes a few seconds to wake, and a network
  // blip can drop a first connection. Nothing here is harmed by being run again (migrations and
  // defaults are applied only where missing), so try a few times before giving up on the build.
  // (This was added on a wrong guess about two failed Vercel builds; their real cause was GitHub
  // refusing Vercel's download of the commit. It is kept because it costs nothing.)
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await prepare(url);
      break;
    } catch (e) {
      const err = e as Error & { code?: string; cause?: { message?: string; code?: string } };
      const cause = err.cause?.message ? ` (caused by: ${err.cause.message}${err.cause.code ? ` [${err.cause.code}]` : ''})` : '';
      console.error(`Preparing the database failed, attempt ${attempt} of ${attempts}: ${err.message}${err.code ? ` [${err.code}]` : ''}${cause}`);
      if (attempt === attempts) throw e;
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
}

async function prepare(databaseUrl: string): Promise<void> {
  const handle = await createDb(databaseUrl, config.migrationsFolder, { poolSize: 2 });
  try {
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
  } finally {
    await handle.close().catch(() => undefined);
  }
}
