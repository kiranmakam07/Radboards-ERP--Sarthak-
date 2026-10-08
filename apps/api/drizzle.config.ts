import { defineConfig } from 'drizzle-kit';

// Used only to GENERATE sql migrations from src/db/schema.ts (`npm run db:generate`).
// Applying them is done by src/db/migrate.ts, which works for both Postgres and PGlite.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
