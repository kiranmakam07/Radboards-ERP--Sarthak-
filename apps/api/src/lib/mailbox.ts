/**
 * Reads the mailbox that bank statements are forwarded to, over IMAP (which Gmail, Zoho Mail and
 * every other mail service offer). It only reads: nothing is deleted, moved or marked.
 *
 * The app is given this one mailbox and nothing else. Mail is still treated as coming from
 * strangers: only attachments are taken from it, each is checked by its content, and nothing in
 * a mail is ever followed as an instruction.
 */

export type MailAttachment = { filename: string; content: Buffer };
export type InboundMail = {
  /** The mail's own id, which is how a mail already dealt with is recognised. */
  messageId: string;
  from: string;
  subject: string;
  date: Date | null;
  /**
   * What the mail service that received the mail found about who really sent it: its own Authentication-Results
   * header (the topmost one), or null when it added none. See signedBySender.
   */
  authResults: string | null;
  attachments: MailAttachment[];
  /** Set when the mail was too large to fetch; it is recorded and skipped. */
  tooLarge?: boolean;
};

export type MailboxConfig = { host: string; port: number; user: string; password: string; folder: string };
export type ReadOptions = {
  /** How far back to look. */
  sinceDays: number;
  /** Mails already dealt with, which are not fetched again. */
  known: (messageId: string) => boolean;
  /** At most this many new mails in one go, oldest first, so one run stays short. */
  max: number;
};

/** A statement is a few hundred kilobytes; anything far beyond that is not one. */
export const MAX_MAIL_BYTES = 12 * 1024 * 1024;

export async function readMailbox(cfg: MailboxConfig, opts: ReadOptions): Promise<InboundMail[]> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.password }, logger: false,
    // Never wait long on a mail server from inside a request.
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });
  const out: InboundMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder, { readOnly: true });
    try {
      const since = new Date(Date.now() - opts.sinceDays * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      for (const uid of uids) {
        if (out.length >= opts.max) break;
        const head = await client.fetchOne(String(uid), { envelope: true, size: true }, { uid: true });
        if (!head) continue;
        const messageId = head.envelope?.messageId || `uid-${cfg.user}-${uid}`;
        if (opts.known(messageId)) continue;
        const from = head.envelope?.from?.[0]?.address ?? '';
        const subject = head.envelope?.subject ?? '';
        const sent = head.envelope?.date ? new Date(head.envelope.date) : null;
        const date = sent && !Number.isNaN(sent.getTime()) ? sent : null;
        if ((head.size ?? 0) > MAX_MAIL_BYTES) {
          out.push({ messageId, from, subject, date, authResults: null, attachments: [], tooLarge: true });
          continue;
        }
        const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!full || !full.source) continue;
        const parsed = await simpleParser(full.source);
        // The receiving service puts its verdict on top; any further down came with the mail and could be made up.
        const verdict = parsed.headerLines.find((h) => h.key === 'authentication-results')?.line ?? null;
        out.push({
          messageId, from, subject, date, authResults: verdict ? verdict.replace(/^authentication-results:\s*/i, '') : null,
          attachments: parsed.attachments
            .filter((a) => Buffer.isBuffer(a.content) && a.content.length > 0)
            .map((a) => ({ filename: a.filename ?? 'attachment', content: a.content })),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}

/**
 * Whether the mail service that received a mail found it signed by the domain its sender's address is in: a DKIM
 * signature that checked out for that domain, or a DMARC pass for it (technical review, 26 Oct 2026: "a statement is
 * trusted on the sender's name alone, so a forged one could mark unpaid money as received"). Anyone can write any
 * sender's address on a mail; only the bank's mail servers can sign for the bank's domain. Forwarding with a mail
 * service's own forwarding rule keeps the bank's signature; a mail forwarded by hand is signed by the person who
 * forwarded it, so its rule names that person's address.
 */
export function signedBySender(mail: { from: string; authResults: string | null }): boolean {
  const domain = mail.from.split('@')[1]?.toLowerCase().trim();
  if (!domain || !mail.authResults) return false;
  const fits = (d: string | undefined) => Boolean(d) && (domain === d || domain.endsWith(`.${d}`));
  for (const result of mail.authResults.toLowerCase().split(';').map((r) => r.trim())) {
    if (/^dmarc=pass\b/.test(result) && fits(result.match(/header\.from=([a-z0-9.-]+)/)?.[1])) return true;
    if (/^dkim=pass\b/.test(result) && fits(result.match(/header\.(?:d|i)=(?:[^@\s;]*@)?([a-z0-9.-]+)/)?.[1])) return true;
  }
  return false;
}
