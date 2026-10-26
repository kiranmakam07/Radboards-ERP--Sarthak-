import type { NextFunction, Request, Response } from 'express';
import type { DB } from '../db/client';
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

/**
 * Reads of the cost and margin reports are audited too (brief P3): who opened which one, with which filters,
 * as a 'read' entry beside the changes. Written once the report has been sent, and only when it was.
 */
export function auditRead(db: DB, report: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (res.statusCode !== 200 || !req.user) return;
      void db.insert(auditLog).values({
        entity: 'report', entityId: report, action: 'read', after: { query: req.query, file: req.query.format ?? null }, userId: req.user.id,
      }).catch((e: unknown) => console.error('Could not record a report read:', e));
    });
    next();
  };
}
