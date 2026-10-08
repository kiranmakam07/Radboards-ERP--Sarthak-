import { config } from '../config';
import { createDb } from './client';

// `npm run db:migrate` - createDb applies any pending migrations from ./drizzle.
const handle = await createDb(config.databaseUrl, config.migrationsFolder);
console.log(`Migrations applied (${handle.kind}).`);
await handle.close();
