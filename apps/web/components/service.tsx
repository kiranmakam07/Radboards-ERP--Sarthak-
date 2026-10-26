import { JOB_CARD_STATUS_LABELS, type JobCardStatus } from '@radcore/shared';

/** Shared by the workshop screens (app/(app)/service). */

/** A datetime-local box's value, read as India's time. */
export const fromLocal = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);

/** The steps a job goes through, as the status bar shows them. */
export const JOB_STEPS: JobCardStatus[] = ['open', 'diagnosed', 'estimate_sent', 'approved', 'in_progress', 'ready', 'delivered'];
export const JOB_STEP_LABELS = JOB_STEPS.map((s) => JOB_CARD_STATUS_LABELS[s]);
