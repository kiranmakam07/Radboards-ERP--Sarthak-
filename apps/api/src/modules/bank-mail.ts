import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { accounts, bankFeeds, bankMails } from '../db/schema';
import { StatementFormatError, parseStatement, type ParsedStatement } from '../lib/bank-csv';
import { StatementPasswordError, isPdf, parsePdfStatement } from '../lib/bank-pdf';
import { AppError, badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, zId, type Ctx } from '../lib/http';
import { type InboundMail, type MailAttachment, type ReadOptions } from '../lib/mailbox';
import { canSeal, seal, unseal } from '../lib/secret-box';
import { importParsed } from './bank';

/**
 * Bank statements that arrive by email.
 *
 * The bank mails the statement, the mail is forwarded to a mailbox kept for this, and the app
 * reads that mailbox. Each bank account has a rule that recognises its mails and the password
 * that opens its statements. A statement that is recognised and reads cleanly goes through the
 * same import as one uploaded by hand: lines already here are skipped, lines the books already
 * explain are matched, and the rest wait on the reconciliation screen for someone to say what
 * they were. Every mail is listed with what became of it; nothing is dropped silently.
 */

export type MailDeps = {
  /** Reads the statements mailbox. Absent when no mailbox is connected; replaced by a stub in tests. */
  readMailbox?: (opts: ReadOptions) => Promise<InboundMail[]>;
};

type Feed = typeof bankFeeds.$inferSelect & { account_name?: string };

/** How far back the mailbox is searched, and how many new mails one run takes on. */
const LOOK_BACK_DAYS = 45;
const PER_RUN = 5;
/** A statement is small; a failed one larger than this is not kept for another try. */
const KEEP_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

const has = (text: string | null | undefined, word: string | null) => !word || (text ?? '').toLowerCase().includes(word.toLowerCase());
/** The accounts whose rule fits a mail: every word the rule gives must be there. */
export const feedsFor = (feeds: Feed[], mail: { from: string | null; subject: string | null }): Feed[] =>
  feeds.filter((f) => f.active && has(mail.from, f.matchFrom) && has(mail.subject, f.matchSubject));

const looksLikeStatement = (a: MailAttachment) => isPdf(a.content) || /\.(csv|txt)$/i.test(a.filename);

type Outcome = {
  status: 'imported' | 'failed' | 'ignored'; accountId: string | null; detail: string;
  importId?: string | null; result?: Record<string, unknown> | null;
};

/** Read one attached statement with each matching account's password in turn, and import it under the one that opens it. */
async function tryImport(ctx: Ctx, candidates: Feed[], attachment: MailAttachment): Promise<Outcome> {
  let problem = 'It could not be read';
  let account = candidates[0]?.accountId ?? null;
  for (const feed of candidates) {
    account = feed.accountId;
    const name = feed.account_name ?? 'this account';
    let parsed: ParsedStatement;
    try {
      parsed = isPdf(attachment.content)
        ? await parsePdfStatement(attachment.content, unseal(feed.passwordSealed))
        : parseStatement(attachment.content.toString('utf8'));
    } catch (e) {
      if (e instanceof StatementPasswordError) {
        problem = e.reason === 'wrong' ? `The password saved for ${name} did not open this statement`
          : feed.passwordSealed ? `The password saved for ${name} can no longer be read (APP_SECRET on the server has changed). Enter it again`
          : `The statement is locked and no password is saved for ${name}`;
        continue; // another account's password may be the one
      }
      if (e instanceof StatementFormatError) {
        problem = e.message;
        break; // the file reads the same whichever account it is for
      }
      throw e;
    }
    if (parsed.errors.length > 0) {
      problem = `${parsed.errors.length} row(s) could not be read (${parsed.errors.slice(0, 3).map((x) => `row ${x.row}: ${x.message}`).join('; ')}). Nothing was imported`;
      break;
    }
    if (parsed.rows.length === 0) {
      problem = 'No transactions were found in it';
      break;
    }
    const result = await importParsed(ctx, feed.accountId, parsed);
    return {
      status: 'imported', accountId: feed.accountId, importId: result.import_id, result,
      detail: `${result.imported} new line(s) for ${name}, ${result.already_present} already here, ${result.auto_matched} matched to the books automatically`,
    };
  }
  return { status: 'failed', accountId: account, detail: problem };
}

/** Deal with one mail: a row per attachment saying what became of it. All of it or none. */
export async function recordMail(db: DB, mail: InboundMail): Promise<Outcome[]> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    const ctx: Ctx = { tx, user: null };
    const feeds = await rows<Feed>(tx, sql`
      select f.id, f.account_id as "accountId", f.match_from as "matchFrom", f.match_subject as "matchSubject",
             f.password_sealed as "passwordSealed", f.active, a.name as account_name
        from bank_feeds f join accounts a on a.id = f.account_id order by f.created_at`);
    const base = { messageId: mail.messageId, fromAddress: mail.from.slice(0, 300), subject: mail.subject.slice(0, 500), receivedAt: mail.date };
    const candidates = feedsFor(feeds, mail);
    const statements = mail.attachments.filter(looksLikeStatement).slice(0, MAX_ATTACHMENTS);
    const skip = mail.tooLarge ? 'The mail is larger than 12 MB, which a statement never is'
      : candidates.length === 0 ? 'It does not match the rule of any bank account, so it was left alone'
      : statements.length === 0 ? 'No statement (PDF or CSV) was attached'
      : null;
    if (skip) {
      await tx.insert(bankMails).values({ ...base, part: 0, status: 'ignored', detail: skip });
      return [{ status: 'ignored', accountId: null, detail: skip }];
    }
    const outcomes: Outcome[] = [];
    for (const [part, attachment] of statements.entries()) {
      const outcome = await tryImport(ctx, candidates, attachment);
      const keep = outcome.status === 'failed' && attachment.content.length <= KEEP_BYTES;
      await tx.insert(bankMails).values({
        ...base, part, accountId: outcome.accountId, attachmentName: attachment.filename.slice(0, 200), attachment: keep ? attachment.content : null,
        status: outcome.status, detail: outcome.detail, importId: outcome.importId ?? null, result: outcome.result ?? null,
      });
      outcomes.push(outcome);
    }
    return outcomes;
  });
}

/** The database refused a second row for the same mail. */
function isRepeat(e: unknown): boolean {
  for (let err = e as { constraint?: string; message?: string; cause?: unknown } | undefined; err; err = err.cause as typeof err) {
    if (err.constraint === 'bank_mails_message_uq' || /bank_mails_message_uq/.test(err.message ?? '')) return true;
  }
  return false;
}

/** What went wrong reaching the mailbox, in words that say what to check. */
function mailboxProblem(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string };
  if (err.authenticationFailed) return 'The mailbox refused the sign-in. Check BANK_MAIL_USER and BANK_MAIL_PASSWORD on the server (an app password, with IMAP switched on for the mailbox).';
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return `The mail server ${config.bankMailHost} could not be reached. Check BANK_MAIL_HOST and BANK_MAIL_PORT.`;
  return `The mailbox could not be read: ${(err.responseText ?? err.message ?? 'unknown error').slice(0, 200)}`;
}

/** Read the mailbox and deal with what is new. Safe to run as often as wanted, and by two people at once. */
export async function checkMailbox(db: DB, deps: MailDeps) {
  if (!deps.readMailbox) return { configured: false as const };
  const known = new Set((await rows<{ message_id: string }>(db, sql`
    select distinct message_id from bank_mails where created_at > now() - make_interval(days => ${LOOK_BACK_DAYS + 30})`)).map((r) => r.message_id));
  const counts = { imported: 0, failed: 0, ignored: 0 };
  let found = 0;
  let error: string | null = null;
  try {
    const mails = await deps.readMailbox({ sinceDays: LOOK_BACK_DAYS, known: (id) => known.has(id), max: PER_RUN });
    for (const mail of mails) {
      if (known.has(mail.messageId)) continue;
      known.add(mail.messageId);
      try {
        for (const o of await recordMail(db, mail)) counts[o.status]++;
        found++;
      } catch (e) {
        // Someone else read the same mail a moment ago: it is theirs, and already dealt with.
        if (isRepeat(e)) continue;
        // Anything else is about this one mail, not the mailbox: say so against the mail and carry on with the rest.
        await db.insert(bankMails).values({
          messageId: mail.messageId, part: 0, fromAddress: mail.from.slice(0, 300), subject: mail.subject.slice(0, 500), receivedAt: mail.date,
          status: 'failed', detail: `It could not be dealt with: ${((e as Error).message ?? 'unknown error').slice(0, 300)}`,
        }).onConflictDoNothing();
        counts.failed++;
        found++;
      }
    }
  } catch (e) {
    error = mailboxProblem(e);
  }
  await setSetting(db, 'bank_mail_state', { last_checked_at: new Date().toISOString(), last_found: found, last_error: error }, null);
  return { configured: true as const, found, ...counts, error };
}

export function bankMailRouter(db: DB, deps: MailDeps) {
  const r = Router();

  /** Everything the "statements by email" part of the screen shows. Passwords are never sent, only whether one is saved. */
  r.get('/mail', requirePerm('accounts:read'), async (_req, res) => {
    const feeds = await rows(db, sql`
      select a.id as account_id, a.code, a.name as account_name, f.match_from, f.match_subject, f.active,
             (f.password_sealed is not null) as has_password, f.id is not null as set_up
        from accounts a left join bank_feeds f on f.account_id = a.id
       where a.subtype = 'bank' and a.active and not a.is_group order by a.code`);
    const mails = await rows(db, sql`
      select m.id, m.from_address, m.subject, m.received_at, m.created_at, m.attachment_name, m.status, m.detail, m.result, m.import_id,
             a.name as account_name, (m.attachment is not null) as can_retry
        from bank_mails m left join accounts a on a.id = m.account_id
       order by m.created_at desc, m.part limit 60`);
    res.json({
      data: {
        configured: Boolean(deps.readMailbox), mailbox: deps.readMailbox ? (config.bankMailUser || 'connected') : null,
        can_save_password: canSeal(), state: await getSetting(db, 'bank_mail_state'), feeds, mails,
      },
    });
  });

  /** How one bank account's statement mails are recognised, and the password that opens them. */
  r.put('/mail/feeds/:accountId', requirePerm('accounts:write'), async (req, res) => {
    const accountId = zId.parse(req.params.accountId);
    const b = z.object({
      match_from: emptyToNull(z.string().trim().max(200)).optional(),
      match_subject: emptyToNull(z.string().trim().max(200)).optional(),
      /** Blank leaves the saved password as it is. */
      password: emptyToNull(z.string().max(200)).optional(),
      forget_password: z.boolean().optional(),
      active: z.boolean().default(true),
    }).parse(req.body);
    if (!b.match_from && !b.match_subject) throw badRequest('Say how these mails are recognised: words from the sender’s address, from the subject, or both');
    await inTx(db, req, async (ctx) => {
      const [account] = await ctx.tx.select().from(accounts).where(eq(accounts.id, accountId));
      if (!account || account.subtype !== 'bank' || account.isGroup) throw badRequest('Pick a bank account');
      const [before] = await ctx.tx.select().from(bankFeeds).where(eq(bankFeeds.accountId, accountId)).for('update');
      const passwordSealed = b.forget_password ? null : b.password ? seal(b.password) : (before?.passwordSealed ?? null);
      const values = { matchFrom: b.match_from ?? null, matchSubject: b.match_subject ?? null, passwordSealed, active: b.active, updatedAt: new Date() };
      if (before) await ctx.tx.update(bankFeeds).set(values).where(eq(bankFeeds.id, before.id));
      else await ctx.tx.insert(bankFeeds).values({ ...values, accountId, createdBy: ctx.user!.id });
      await audit(ctx, 'bank_feed', accountId, before ? 'update' : 'create',
        before ? { matchFrom: before.matchFrom, matchSubject: before.matchSubject, active: before.active, hasPassword: Boolean(before.passwordSealed) } : null,
        { matchFrom: values.matchFrom, matchSubject: values.matchSubject, active: values.active, hasPassword: Boolean(passwordSealed) });
    });
    res.json({ ok: true });
  });

  r.post('/mail/check', requirePerm('accounts:write'), async (_req, res) => {
    const result = await checkMailbox(db, deps);
    if (!result.configured) throw conflict('No mailbox is connected yet. It is set on the server (BANK_MAIL_HOST, BANK_MAIL_USER, BANK_MAIL_PASSWORD).');
    res.json({ data: result });
  });

  /** A statement that could not be imported, tried again after the password or the rule was put right. */
  r.post('/mail/:id/retry', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const outcome = await inTx(db, req, async (ctx) => {
      const [mail] = await ctx.tx.select().from(bankMails).where(eq(bankMails.id, id)).for('update');
      must(mail, 'Mail');
      if (mail!.status === 'imported') throw conflict('This statement is already imported');
      if (!mail!.attachment) throw conflict('The file was not kept. Forward the bank’s mail to the mailbox again.');
      const feeds = await rows<Feed>(ctx.tx, sql`
        select f.id, f.account_id as "accountId", f.match_from as "matchFrom", f.match_subject as "matchSubject",
               f.password_sealed as "passwordSealed", f.active, a.name as account_name
          from bank_feeds f join accounts a on a.id = f.account_id order by f.created_at`);
      const candidates = feedsFor(feeds, { from: mail!.fromAddress, subject: mail!.subject });
      if (candidates.length === 0) throw conflict('This mail does not match the rule of any bank account. Set the rule first.');
      const result = await tryImport(ctx, candidates, { filename: mail!.attachmentName ?? 'statement', content: mail!.attachment });
      await ctx.tx.update(bankMails).set({
        status: result.status, detail: result.detail, accountId: result.accountId, importId: result.importId ?? null, result: result.result ?? null,
        attachment: result.status === 'imported' ? null : mail!.attachment, updatedAt: new Date(),
      }).where(eq(bankMails.id, id));
      await audit(ctx, 'bank_mail', id, 'retry', { status: mail!.status }, { status: result.status, detail: result.detail });
      return result;
    });
    if (outcome.status !== 'imported') throw new AppError(422, 'statement_not_imported', `${outcome.detail}.`);
    res.json({ data: outcome });
  });

  /** Stop showing a mail as needing attention (a mail that was never a statement, or one imported by hand since). */
  r.post('/mail/:id/dismiss', requirePerm('accounts:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [mail] = await ctx.tx.select({ status: bankMails.status }).from(bankMails).where(eq(bankMails.id, id)).for('update');
      must(mail, 'Mail');
      if (mail!.status !== 'failed') throw conflict('Only a statement that could not be imported can be set aside');
      await ctx.tx.update(bankMails).set({ status: 'ignored', attachment: null, detail: sql`${bankMails.detail} || ' (set aside)'`, updatedAt: new Date() }).where(eq(bankMails.id, id));
      await audit(ctx, 'bank_mail', id, 'dismiss', { status: 'failed' }, { status: 'ignored' });
    });
    res.json({ ok: true });
  });
  return r;
}

/**
 * For a scheduler (a cron job on the server, or the host's own scheduler): ask for the mailbox to
 * be read. It proves itself with BANK_MAIL_CRON_SECRET as a bearer token; without one set on the
 * server this address does not exist.
 */
export function bankMailHookRouter(db: DB, deps: MailDeps) {
  const r = Router();
  r.all('/check', async (req, res) => {
    const secret = config.bankMailCronSecret;
    const given = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!secret || !crypto.timingSafeEqual(a, b)) throw new AppError(404, 'not_found', 'No such API route');
    res.json({ data: await checkMailbox(db, deps) });
  });
  return r;
}

