import { sql } from 'drizzle-orm';
import { OPEN_LEAD_STAGES } from '@radcore/shared';

/**
 * The open lead stages as a list for SQL (`l.stage in (${OPEN_STAGES})`), made from OPEN_LEAD_STAGES so
 * that a stage added there counts everywhere: follow-ups, the pipeline, the dashboards, the score.
 */
export const OPEN_STAGES = sql.raw(OPEN_LEAD_STAGES.map((s) => `'${s}'`).join(', '));
/** The open stages a lead reaches once someone has spoken to it: all but new. */
export const WORKING_STAGES = sql.raw(OPEN_LEAD_STAGES.filter((s) => s !== 'new').map((s) => `'${s}'`).join(', '));
