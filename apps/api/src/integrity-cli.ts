import { createDb, isPostgresUrl } from './db/client';
import { config } from './config';
import { integrityReport } from './modules/accounting';

/**
 * `npm run integrity -w @radcore/api -- <postgres://...>`: the books health check against any database,
 * without the web app or a sign-in. The monthly restore drill (deploy/restore-drill.sh) runs it against a
 * backup restored into a scratch database: a backup that cannot be restored, or restores into books that
 * do not balance, fails the drill. Prints the report; exits 1 when something is wrong.
 */
const url = process.argv[2] ?? config.databaseUrl;
if (!isPostgresUrl(url)) {
  console.error('Give the address of a PostgreSQL database: postgres://user:password@host:5432/name');
  process.exit(2);
}
const handle = await createDb(url, config.migrationsFolder, { migrate: false, poolSize: 1 });
try {
  const report = await integrityReport(handle.db);
  console.log(JSON.stringify(report, null, 2));
  const healthy = report.journal_balanced && report.unbalanced_entries === 0 && report.stock_matches_gl;
  console.log(healthy ? 'Books healthy.' : 'BOOKS NOT HEALTHY.');
  process.exitCode = healthy ? 0 : 1;
} finally {
  await handle.close();
}
