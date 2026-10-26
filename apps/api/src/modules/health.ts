import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { config } from '../config';
import { sendAlert } from '../core/alerts';
import { requirePerm } from '../core/auth';
import { runJobs } from '../core/jobs';
import { getSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { AppError } from '../lib/errors';
import type { MailDeps } from './bank-mail';

/**
 * System health (technical review, 26 Oct 2026): what went wrong lately, when the background jobs last ran, and
 * whether alerts reach anyone. Admin → System health.
 *   healthRouter      /api/settings/health (audit:read): the page, and a test alert
 *   jobsHookRouter    /api/hooks/jobs/run: a scheduler runs the background jobs (with CRON_SECRET)
 */
export function healthRouter(db: DB) {
  const r = Router();
  r.get('/', requirePerm('audit:read'), async (_req, res) => {
    res.json({
      data: {
        errors: await rows(db, sql`
          select e.id, e.at, e.source, e.message, u.name as user_name from error_log e left join users u on u.id = e.user_id
           order by e.at desc limit 50`),
        errors_last_day: (await rows<{ n: number }>(db, sql`select count(*)::int as n from error_log where at > now() - interval '1 day'`))[0]!.n,
        jobs: await getSetting(db, 'jobs_state'),
        bank_mail: await getSetting(db, 'bank_mail_state'),
        alerts_on: Boolean(config.alertWebhookUrl),
        scheduler: config.scheduler === 'off' ? 'cron' : 'server',
      },
    });
  });

  /** Send a test line to the alert channel, to see that it arrives. */
  r.post('/test-alert', requirePerm('audit:read'), async (req, res) => {
    if (!config.alertWebhookUrl) throw new AppError(409, 'not_set', 'No alert channel is set on the server (ALERT_WEBHOOK_URL).');
    const sent = await sendAlert(`RadCore: a test alert sent by ${req.user!.name}. Problems will arrive here.`);
    if (!sent) throw new AppError(502, 'not_sent', 'The alert channel did not accept the message. Check ALERT_WEBHOOK_URL on the server.');
    res.json({ data: { sent: true } });
  });
  return r;
}

export function jobsHookRouter(db: DB, deps: MailDeps) {
  const r = Router();
  r.all('/run', async (req, res) => {
    const secret = config.cronSecret;
    const given = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!secret || !crypto.timingSafeEqual(a, b)) throw new AppError(404, 'not_found', 'No such API route');
    res.json({ data: await runJobs(db, deps) });
  });
  return r;
}
