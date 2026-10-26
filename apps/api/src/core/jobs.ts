import { sql } from 'drizzle-orm';
import { config } from '../config';
import { rows, type DB } from '../db/client';
import { checkMailbox, type MailDeps } from '../modules/bank-mail';
import { ensureTasks } from '../modules/ops';
import { expireReservations } from '../modules/reservations';
import { recordProblem } from './alerts';
import { setSetting } from './settings';

/**
 * The work that happens by itself (technical review, 26 Oct 2026: "jobs described as automatic run only when
 * someone opens a screen"). Each run:
 *   daily_tasks    the day's tasks from the routines (Operations)
 *   reservations   stock held past its date is let go
 *   bank_mail      the statements mailbox is read, when one is connected
 *   housekeeping   save keys older than a day and error records older than 90 days are cleared
 * Each job is on its own: one failing is recorded (and alerted) and the others still run. Every job is safe to
 * run any number of times, also by two servers at once, and the screens still run the same work when opened.
 *
 * On a server the API runs these itself every 15 minutes (startScheduler, from server.ts). Where the API only
 * answers requests (the Vercel review copy), a cron calls /api/hooks/jobs/run with CRON_SECRET.
 */
export type JobResult = Record<string, string>;

export async function runJobs(db: DB, deps: MailDeps): Promise<JobResult> {
  const result: JobResult = {};
  const job = async (name: string, work: () => Promise<string>) => {
    try {
      result[name] = await work();
    } catch (e) {
      result[name] = `failed: ${(e as Error).message}`;
      await recordProblem(db, { source: `job:${name}`, message: (e as Error).message ?? String(e), detail: (e as Error).stack ?? null });
    }
  };
  await job('daily_tasks', async () => `${await ensureTasks(db)} task(s) made`);
  await job('reservations', async () => {
    await db.transaction(async (trx) => expireReservations({ tx: trx as unknown as DB, user: null }));
    return 'done';
  });
  await job('bank_mail', async () => {
    const r = await checkMailbox(db, deps);
    if (!('found' in r)) return 'no mailbox connected';
    if (r.error) throw new Error(`The statements mailbox could not be read: ${r.error}`);
    return `${r.found} new mail(s)`;
  });
  await job('housekeeping', async () => {
    await rows(db, sql`delete from idempotency_keys where created_at < now() - interval '1 day'`);
    await rows(db, sql`delete from error_log where at < now() - interval '90 days'`);
    return 'done';
  });
  await setSetting(db, 'jobs_state', { last_run_at: new Date().toISOString(), result }, null);
  return result;
}

/** Run the jobs every `everyMs` while this server runs (the first run half a minute after starting). */
export function startScheduler(db: DB, deps: MailDeps, everyMs = 15 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // the last run is still going
    running = true;
    try {
      await runJobs(db, deps);
    } catch (e) {
      console.error('scheduler', e);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 30_000);
  const every = setInterval(tick, everyMs);
  first.unref();
  every.unref();
  if (config.env !== 'test') console.log(`Scheduler: background jobs every ${Math.round(everyMs / 60_000)} minutes`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
