import { auditLog } from '../db/schema';
import type { Ctx } from '../lib/http';

/**
 * Audit trail (PRD section 9): every create, update, cancel and status change is logged
 * with the user, time and before/after values, in the same transaction as the change.
 */
export async function audit(
  ctx: Ctx,
  entity: string,
  entityId: string,
  action: string,
  before: unknown = null,
  after: unknown = null,
): Promise<void> {
  await ctx.tx.insert(auditLog).values({
    entity,
    entityId,
    action,
    before: before === null ? null : (JSON.parse(JSON.stringify(before)) as object),
    after: after === null ? null : (JSON.parse(JSON.stringify(after)) as object),
    userId: ctx.user?.id ?? null,
  });
}
