import { sql } from 'drizzle-orm';
import { config } from '../config';
import { rows, type DB } from '../db/client';

/**
 * Saying when something goes wrong (technical review, 26 Oct 2026: "nothing records errors or warns anyone
 * when something fails").
 *
 * Every unexpected error (a request that failed with a 500, a background job that failed) is kept in error_log,
 * which Admin → System health lists. With ALERT_WEBHOOK_URL set on the server (an incoming webhook of Slack,
 * Google Chat or Discord, or an ntfy.sh topic), it is also sent there: the same kind of problem at most once in
 * ALERT_QUIET_MINUTES, so a fault that repeats does not flood the channel. The backups and the restore drill send
 * theirs to the same address (deploy/backup.sh, deploy/restore-drill.sh).
 */
export type Problem = {
  /** Where it happened: a request ("GET /api/sales/orders"), a job ("job:bank_mail"), and so on. */
  source: string;
  message: string;
  detail?: string | null;
  userId?: string | null;
};

const ALERT_QUIET_MINUTES = 15;
const lastSent = new Map<string, number>();

/** Send a line to the alert channel, if one is set. Never throws: an alert that cannot be sent is only logged. */
export async function sendAlert(text: string): Promise<boolean> {
  if (!config.alertWebhookUrl) return false;
  try {
    const res = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack and Google Chat read `text`, Discord reads `content`.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (e) {
    console.error('alert could not be sent', e);
    return false;
  }
}

/** Keep a problem in error_log and, unless the same kind was just sent, send it to the alert channel. */
export async function recordProblem(db: DB, p: Problem): Promise<void> {
  try {
    await rows(db, sql`
      insert into error_log (source, message, detail, user_id)
      values (${p.source.slice(0, 200)}, ${p.message.slice(0, 1000)}, ${p.detail?.slice(0, 8000) ?? null}, ${p.userId ?? null})`);
  } catch (e) {
    console.error('error_log: could not keep a problem', e);
  }
  const kind = `${p.source}|${p.message.slice(0, 120)}`;
  const now = Date.now();
  if ((lastSent.get(kind) ?? 0) > now - ALERT_QUIET_MINUTES * 60_000) return;
  lastSent.set(kind, now);
  await sendAlert(`RadCore${config.publicUrl ? ` (${config.publicUrl})` : ''}: ${p.source}: ${p.message}`);
}
