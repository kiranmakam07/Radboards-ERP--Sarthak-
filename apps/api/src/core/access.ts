import type { DB } from '../db/client';
import { accessLog } from '../db/schema';

/**
 * DPDP (brief P3): note that someone opened a customer's full record (a lead or a party), with its phone
 * and address. Read by admins on the Audit trail (GET /api/admin/access-log).
 */
export async function logAccess(db: DB, userId: string, recordType: 'lead' | 'party', recordId: string): Promise<void> {
  await db.insert(accessLog).values({ userId, recordType, recordId });
}
