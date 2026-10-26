import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { rows, sql } from '../src/db/client';
import type { InboundMail, ReadOptions } from '../src/lib/mailbox';
import { canSeal, seal, unseal } from '../src/lib/secret-box';
import { checkMailbox, feedsFor } from '../src/modules/bank-mail';
import { expectBooksHealthy, masters, setup, type World } from './helpers';
import { USUAL_COLS, statementPdf } from './statement-pdf';

let w: World;
let m: Awaited<ReturnType<typeof masters>>;
let bank: string;
let second: string;
const original = { appSecret: config.appSecret, cron: config.bankMailCronSecret };

// The pretend mailbox. Like a real one it is asked only for mails not yet dealt with.
let inbox: InboundMail[] = [];
let mailboxDown: unknown = null;
let ignoreKnown = false;
const readMailbox = async (opts: ReadOptions): Promise<InboundMail[]> => {
  if (mailboxDown) throw mailboxDown;
  return inbox.filter((mail) => ignoreKnown || !opts.known(mail.messageId)).slice(0, opts.max);
};

const BANK_FROM = 'statements@idfcfirstbank.com';
const SUBJECT = 'IDFC FIRST Bank Account statement for the month of September 2026';
const PASSWORD = 'RADB0102';
/** What the receiving mail service says of a genuine bank mail: signed by the bank's domain. */
const SIGNED = 'mx.mail.test; dkim=pass header.i=@idfcfirstbank.com header.s=s1; spf=pass smtp.mailfrom=idfcfirstbank.com; dmarc=pass (p=REJECT) header.from=idfcfirstbank.com';
const mail = (id: string, attachments: { filename: string; content: Buffer }[], over: Partial<InboundMail> = {}): InboundMail => {
  const from = over.from ?? BANK_FROM;
  return {
    messageId: `<${id}@mail.test>`, from, subject: SUBJECT, date: new Date('2026-10-01T04:30:00Z'), attachments,
    authResults: SIGNED.replaceAll('idfcfirstbank.com', from.split('@')[1]!), ...over,
  };
};

// 1,00,000 to start with. The second and fourth rows are already in the books; the rest are not.
const WEEK = [
  ['01-Sep-2026', '01-Sep-2026', 'UPI/CR/624512345678/RHEA MENON/HDFC/rhea@okhdfc/Payment for board', '', '', '5,900.00', '1,05,900.00'],
  ['02-Sep-2026', '02-Sep-2026', 'NEFT/N245260012345/BANGALORE BOARDS/INV-26-27-00012', '', '', '23,600.00', '1,29,500.00'],
  ['03-Sep-2026', '03-Sep-2026', 'CHQ PAID/DECK MAKERS PVT LTD', '000123', '50,000.00', '', '79,500.00'],
  ['04-Sep-2026', '04-Sep-2026', 'ACH/RENT SEP 2026/R K PROPERTIES', '', '36,000.00', '', '43,500.00'],
  ['05-Sep-2026', '05-Sep-2026', 'UPI/CR/624798765432/AMAZON SELLER SERVICES/Settlement', '', '', '12,345.67', '55,845.67'],
  ['07-Sep-2026', '07-Sep-2026', 'SMS CHARGES FOR QTR', '', '17.70', '', '55,827.97'],
];
const NEXT = [
  ['08-Sep-2026', '08-Sep-2026', 'UPI/CR/624811112222/MUMBAI SKATE CO', '', '', '3,584.00', '59,411.97'],
  ['09-Sep-2026', '09-Sep-2026', 'ATM CASH WITHDRAWAL PUNE', '', '10,000.00', '', '49,411.97'],
];
const LATER = [
  ['11-Sep-2026', '11-Sep-2026', 'IMPS/P2A/625412341234/SALARY ADVANCE', '', '5,000.00', '', '44,411.97'],
  ['12-Sep-2026', '12-Sep-2026', 'UPI/CR/625512121212/WALK IN CUSTOMER', '', '', '1,180.00', '45,591.97'],
];
const pdf = (rows: string[][], password: string | undefined = PASSWORD) => statementPdf({ cols: USUAL_COLS, rows, password, top: ['IDFC FIRST Bank', 'Statement of account'] });
const lines = async (accountId = bank) =>
  (await (await w.as('accounts')).get(`/api/bank/reconciliation?account_id=${accountId}`).expect(200)).body.data;
const mailList = async () => (await (await w.as('accounts')).get('/api/bank/mail').expect(200)).body.data;
const check = async () => (await (await w.as('accounts')).post('/api/bank/mail/check').send({}).expect(200)).body.data;

beforeAll(async () => {
  config.appSecret = 'a-long-random-text-for-the-tests-0123456789';
  w = await setup(undefined, undefined, readMailbox);
  m = await masters(w.db);
  bank = m.account('bank');
  const accounts = await w.as('accounts');
  second = (await accounts.post('/api/accounting/accounts').send({ code: '1120', name: 'ICICI Current Account', type: 'asset', subtype: 'bank' }).expect(201)).body.data.id;
  // Already in the books before any statement arrives: Bangalore's NEFT, entered when it came, and September's rent.
  const dealer = (await (await w.as('admin')).post('/api/parties').send({ party_type: 'dealer', name: 'Bangalore Boards', phone: '9700000002' }).expect(201)).body.data.id;
  await accounts.post('/api/payments').send({ direction: 'in', party_id: dealer, mode: 'bank_transfer', amount: 23600, reference: 'N245260012345', paid_on: '2026-09-02' }).expect(201);
  await accounts.post('/api/accounting/expenses').send({ category_id: m.expenseCategory('Rent'), amount: 36000, paid_from_account_id: bank, expense_date: '2026-09-04', vendor_name: 'R K Properties' }).expect(201);
});
afterAll(async () => {
  config.appSecret = original.appSecret;
  config.bankMailCronSecret = original.cron;
  await w.close();
});

describe('the password that opens a statement', () => {
  it('is kept locked: it can be read back by the server and by nobody looking at the database', () => {
    const sealed = seal(PASSWORD);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(PASSWORD);
    expect(seal(PASSWORD)).not.toBe(sealed); // never the same twice
    expect(unseal(sealed)).toBe(PASSWORD);
    expect(unseal(sealed.slice(0, -4) + 'AAAA')).toBeNull(); // tampered with
    expect(unseal(null)).toBeNull();
    config.appSecret = 'a-different-secret-altogether-9876543210';
    expect(unseal(sealed)).toBeNull(); // the server's key changed
    config.appSecret = '';
    expect(canSeal()).toBe(false);
    expect(() => seal(PASSWORD)).toThrow(/APP_SECRET/);
    config.appSecret = 'a-long-random-text-for-the-tests-0123456789';
  });
});

describe('setting up statements by email', () => {
  it('says nothing is connected when the server has no mailbox', async () => {
    expect(await checkMailbox(w.db, {})).toEqual({ configured: false });
  });

  it('takes a rule and a password for a bank account, and never shows the password again', async () => {
    const accounts = await w.as('accounts');
    await accounts.put(`/api/bank/mail/feeds/${bank}`).send({ password: PASSWORD }).expect(400); // how are the mails recognised?
    await accounts.put(`/api/bank/mail/feeds/${m.account('cash')}`).send({ match_subject: 'statement' }).expect(400); // not a bank account
    await (await w.as('owner')).put(`/api/bank/mail/feeds/${bank}`).send({ match_subject: 'statement' }).expect(403);
    await accounts.put(`/api/bank/mail/feeds/${bank}`).send({ match_from: 'idfcfirstbank.com', match_subject: 'account statement', password: PASSWORD }).expect(200);

    const page = await accounts.get('/api/bank/mail').expect(200);
    expect(JSON.stringify(page.body)).not.toContain(PASSWORD);
    expect(page.body.data).toMatchObject({ configured: true, can_save_password: true, mails: [] });
    expect(page.body.data.feeds.map((f: any) => [f.account_name, f.set_up, f.has_password, f.match_from, f.match_subject])).toEqual([
      ['Bank Account', true, true, 'idfcfirstbank.com', 'account statement'], ['ICICI Current Account', false, false, null, null],
    ]);
    const [stored] = await rows<{ password_sealed: string }>(w.db, sql`select password_sealed from bank_feeds`);
    expect(stored!.password_sealed).not.toContain(PASSWORD);
    // Saving the rule again without a password keeps the one already saved.
    await accounts.put(`/api/bank/mail/feeds/${bank}`).send({ match_from: 'idfcfirstbank.com', match_subject: 'account statement' }).expect(200);
    expect((await mailList()).feeds[0].has_password).toBe(true);
    // The audit trail records that a password was set, not what it is.
    const log = (await (await w.as('admin')).get('/api/settings/audit-log?entity=bank_feed').expect(200)).body.data;
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
    expect(log[0].after).toMatchObject({ has_password: true });
    await (await w.as('sales')).get('/api/bank/mail').expect(403);
  });

  it('refuses to save a password while the server has no key to lock it with', async () => {
    config.appSecret = '';
    const res = await (await w.as('accounts')).put(`/api/bank/mail/feeds/${second}`).send({ match_subject: 'icici', password: 'x' }).expect(409);
    expect(res.body.error.message).toMatch(/APP_SECRET/);
    expect((await mailList()).can_save_password).toBe(false);
    config.appSecret = 'a-long-random-text-for-the-tests-0123456789';
  });

  it('recognises a mail only when every word of the rule is there', () => {
    const feeds = [{ id: '1', accountId: 'a', matchFrom: 'idfcfirstbank.com', matchSubject: 'Account Statement', passwordSealed: null, active: true }] as any;
    expect(feedsFor(feeds, { from: 'Statements@IDFCFirstBank.com', subject: 'IDFC FIRST Bank account statement for September' })).toHaveLength(1);
    expect(feedsFor(feeds, { from: 'offers@idfcfirstbank.com', subject: 'A festive offer' })).toHaveLength(0);
    expect(feedsFor(feeds, { from: 'someone@elsewhere.example', subject: 'account statement' })).toHaveLength(0);
    expect(feedsFor([{ ...feeds[0], active: false }], { from: BANK_FROM, subject: SUBJECT })).toHaveLength(0);
  });
});

describe('a statement arrives', () => {
  it('opens the locked PDF, imports its lines, matches what the books already have, and leaves other mail alone', async () => {
    inbox = [
      mail('sep-week-1', [{ filename: 'Statement_01Sep_07Sep.pdf', content: await pdf(WEEK) }]),
      mail('offer', [{ filename: 'offer.pdf', content: await pdf(WEEK) }], { from: 'offers@idfcfirstbank.com', subject: 'A festive offer for you' }),
      // Somebody else writes to the mailbox with a "statement" of their own making.
      mail('stranger', [{ filename: 'statement.pdf', content: await pdf([['01-Sep-2026', '01-Sep-2026', 'FAKE RECEIPT', '', '', '9,99,999.00', '9,99,999.00']], undefined) }],
        { from: 'someone@elsewhere.example', subject: 'Your account statement' }),
      mail('no-file', []),
    ];
    expect(await check()).toMatchObject({ configured: true, found: 4, imported: 1, ignored: 3, failed: 0, error: null });

    const r = await lines();
    expect(r.lines).toHaveLength(6);
    expect(r.summary).toMatchObject({ statement_balance: '55827.97', unmatched_statement_lines: 4 });
    const byText = (t: string) => r.lines.find((l: any) => l.description.includes(t));
    expect(byText('BANGALORE BOARDS')).toMatchObject({ status: 'matched', amount: '23600.00' });
    expect(byText('RENT SEP 2026')).toMatchObject({ status: 'matched', amount: '-36000.00' });
    expect(byText('RHEA MENON')).toMatchObject({ status: 'unmatched', amount: '5900.00', description: 'UPI/CR/624512345678/RHEA MENON/HDFC/rhea@okhdfc/Payment for board' });
    expect(byText('DECK MAKERS')).toMatchObject({ status: 'unmatched', amount: '-50000.00', reference: '000123' });
    expect(JSON.stringify(r.lines)).not.toContain('FAKE RECEIPT');

    const page = await mailList();
    expect(page.state).toMatchObject({ last_found: 4, last_error: null });
    const about = (subject: string) => page.mails.find((x: any) => x.subject === subject);
    expect(page.mails.find((x: any) => x.attachment_name === 'Statement_01Sep_07Sep.pdf')).toMatchObject({
      status: 'imported', account_name: 'Bank Account', attachment_name: 'Statement_01Sep_07Sep.pdf', can_retry: false,
      detail: '6 new line(s) for Bank Account, 0 already here, 2 matched to the books automatically',
    });
    expect(about('A festive offer for you')).toMatchObject({ status: 'ignored', detail: 'It does not match the rule of any bank account, so it was left alone' });
    expect(about('Your account statement')).toMatchObject({ status: 'ignored' });
    expect(page.mails.filter((x: any) => x.detail === 'No statement (PDF or CSV) was attached')).toHaveLength(1);
  });

  it('deals with each mail once, however often the mailbox is read', async () => {
    expect(await check()).toMatchObject({ found: 0, imported: 0 });
    ignoreKnown = true; // a mail server that hands everything over again
    expect(await check()).toMatchObject({ found: 0, imported: 0 });
    ignoreKnown = false;
    expect((await lines()).lines).toHaveLength(6);
    expect((await mailList()).mails).toHaveLength(4);
  });

  it('adds only what is new when a later statement covers the same days again, even worded differently', async () => {
    // The fortnight's statement repeats the first week; the bank has shortened one narration.
    const again = WEEK.map((row, i) => (i === 0 ? [...row.slice(0, 2), 'UPI/CR/624512345678/RHEA MENON', ...row.slice(3)] : row));
    inbox.push(mail('sep-fortnight', [{ filename: 'Statement_01Sep_09Sep.pdf', content: await pdf([...again, ...NEXT]) }]));
    expect(await check()).toMatchObject({ found: 1, imported: 1 });
    const page = await mailList();
    expect(page.mails[0].detail).toBe('2 new line(s) for Bank Account, 6 already here, 0 matched to the books automatically');
    const r = await lines();
    expect(r.lines).toHaveLength(8);
    expect(r.summary.statement_balance).toBe('49411.97');
  });

  it('keeps a statement it cannot open, says why, and imports it once the password is put right', async () => {
    const accounts = await w.as('accounts');
    await accounts.put(`/api/bank/mail/feeds/${bank}`).send({ match_from: 'idfcfirstbank.com', match_subject: 'account statement', password: 'the-old-password' }).expect(200);
    inbox.push(mail('sep-later', [{ filename: 'Statement_11Sep_12Sep.pdf', content: await pdf(LATER) }]));
    expect(await check()).toMatchObject({ found: 1, imported: 0, failed: 1 });
    let failed = (await mailList()).mails[0];
    expect(failed).toMatchObject({ status: 'failed', can_retry: true, detail: 'The password saved for Bank Account did not open this statement' });
    expect((await lines()).lines).toHaveLength(8);
    // Trying again changes nothing until the password is right.
    expect((await accounts.post(`/api/bank/mail/${failed.id}/retry`).send({}).expect(422)).body.error.message).toMatch(/did not open this statement/);

    await accounts.put(`/api/bank/mail/feeds/${bank}`).send({ match_from: 'idfcfirstbank.com', match_subject: 'account statement', password: PASSWORD }).expect(200);
    const done = (await accounts.post(`/api/bank/mail/${failed.id}/retry`).send({}).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'imported', detail: '2 new line(s) for Bank Account, 0 already here, 0 matched to the books automatically' });
    failed = (await mailList()).mails.find((x: any) => x.id === failed.id);
    expect(failed).toMatchObject({ status: 'imported', can_retry: false });
    expect((await lines()).lines).toHaveLength(10);
    await accounts.post(`/api/bank/mail/${failed.id}/retry`).send({}).expect(409); // already in
    // The file is not kept once it is in.
    expect((await rows<{ n: number }>(w.db, sql`select count(*)::int as n from bank_mails where attachment is not null`))[0]!.n).toBe(0);
  });

  it('imports nothing from a statement whose figures do not add up, and lets it be set aside', async () => {
    const accounts = await w.as('accounts');
    const wrong = LATER.map((row, i) => [...row.slice(0, 6), `${i + 3},333.00`]).concat([['13-Sep-2026', '13-Sep-2026', 'X', '', '1.00', '', '9.00'], ['14-Sep-2026', '14-Sep-2026', 'Y', '', '1.00', '', '2.00']]);
    inbox.push(mail('garbled', [{ filename: 'garbled.pdf', content: await pdf(wrong) }]));
    expect(await check()).toMatchObject({ found: 1, imported: 0, failed: 1 });
    const failed = (await mailList()).mails[0];
    expect(failed.detail).toMatch(/do not add up/);
    expect((await lines()).lines).toHaveLength(10);
    await accounts.post(`/api/bank/mail/${failed.id}/dismiss`).send({}).expect(200);
    await accounts.post(`/api/bank/mail/${failed.id}/dismiss`).send({}).expect(409);
    expect((await mailList()).mails[0]).toMatchObject({ status: 'ignored', can_retry: false });
  });

  it('puts a statement in the account whose password opens it when two accounts get the same kind of mail', async () => {
    const accounts = await w.as('accounts');
    await accounts.put(`/api/bank/mail/feeds/${second}`).send({ match_from: 'idfcfirstbank.com', match_subject: 'account statement', password: 'SECOND99' }).expect(200);
    const other = [['15-Sep-2026', '15-Sep-2026', 'NEFT/OPENING DEPOSIT', '', '', '25,000.00', '25,000.00'], ['16-Sep-2026', '16-Sep-2026', 'CHEQUE BOOK CHARGES', '', '118.00', '', '24,882.00'],
      ['17-Sep-2026', '17-Sep-2026', 'UPI/CR/626012345678/DEALER ADVANCE', '', '', '10,000.00', '34,882.00']];
    inbox.push(mail('second-account', [{ filename: 'Statement.pdf', content: await pdf(other, 'SECOND99') }]));
    expect(await check()).toMatchObject({ found: 1, imported: 1, failed: 0 });
    expect((await mailList()).mails[0]).toMatchObject({ status: 'imported', account_name: 'ICICI Current Account' });
    expect((await lines(second)).lines).toHaveLength(3);
    expect((await lines()).lines).toHaveLength(10);
  });

  it('takes a statement the bank sends as CSV as well', async () => {
    const csv = 'Transaction Date,Narration,Cheque No,Debit,Credit,Balance\n18/09/2026,UPI/CR/626112345678/WEEKEND SALE,,,2360.00,47951.97\n';
    // A mail with two statements: each is dealt with on its own line.
    inbox.push(mail('csv', [{ filename: 'statement.csv', content: Buffer.from(csv) }, { filename: 'notes.docx', content: Buffer.from('not a statement') }]));
    expect(await check()).toMatchObject({ found: 1, imported: 1 });
    expect((await lines()).lines).toHaveLength(11);
  });

  it('reports a mailbox that cannot be reached without losing anything', async () => {
    mailboxDown = Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true });
    const result = await check();
    expect(result).toMatchObject({ configured: true, found: 0 });
    expect(result.error).toMatch(/refused the sign-in.*BANK_MAIL_PASSWORD/);
    expect((await mailList()).state.last_error).toMatch(/refused the sign-in/);
    mailboxDown = Object.assign(new Error('getaddrinfo ENOTFOUND imap.example.test'), { code: 'ENOTFOUND' });
    expect((await check()).error).toMatch(/could not be reached/);
    mailboxDown = null;
    expect(await check()).toMatchObject({ error: null });
    expect((await mailList()).state.last_error).toBeNull();
  });

  it('can be asked to check by a scheduler that knows the secret, and by nobody else', async () => {
    const { default: request } = await import('supertest');
    await request(w.app).get('/api/hooks/bank-mail/check').expect(404); // no secret set: the address does not exist
    config.bankMailCronSecret = 'cron-secret-123';
    await request(w.app).get('/api/hooks/bank-mail/check').expect(404);
    await request(w.app).get('/api/hooks/bank-mail/check').set('Authorization', 'Bearer wrong').expect(404);
    const ok = await request(w.app).get('/api/hooks/bank-mail/check').set('Authorization', 'Bearer cron-secret-123').expect(200);
    expect(ok.body.data).toMatchObject({ configured: true, found: 0, error: null });
  });

  it('holds a statement whose sender is not proven by the bank’s signature, until a person imports it (technical review, 26 Oct 2026)', async () => {
    const accounts = await w.as('accounts');
    const before = (await lines()).lines.length;
    const forged = [['15-Sep-2026', '15-Sep-2026', 'NEFT/N258/PUNE BOARDS/INV-26-27-00031', '', '', '45,000.00', '90,591.97']];
    // The bank's address written on a mail sent from somewhere else: no signature at all, or one from another domain.
    inbox.push(mail('forged-1', [{ filename: 'Statement_15Sep.pdf', content: await pdf(forged) }], { authResults: null }));
    inbox.push(mail('forged-2', [{ filename: 'Statement_15Sep.pdf', content: await pdf(forged) }], {
      authResults: 'mx.mail.test; dkim=pass header.d=cheap-mailer.example; spf=fail smtp.mailfrom=cheap-mailer.example; dmarc=fail header.from=idfcfirstbank.com',
    }));
    expect(await check()).toMatchObject({ found: 2, imported: 0, failed: 2 });
    const held = (await mailList()).mails.slice(0, 2);
    for (const m of held) {
      expect(m).toMatchObject({ status: 'failed', can_retry: true });
      expect(m.detail).toMatch(/Not proven to come from statements@idfcfirstbank\.com/);
    }
    expect((await lines()).lines).toHaveLength(before); // nothing came in
    // A person who has checked it can still bring it in.
    await accounts.post(`/api/bank/mail/${held[0].id}/retry`).send({}).expect(200);
    expect((await lines()).lines).toHaveLength(before + 1);
    await accounts.post(`/api/bank/mail/${held[1].id}/dismiss`).send({}).expect(200);
  });
});

describe('a statement PDF uploaded by hand', () => {
  const upload = async (accountId: string, body: Buffer, headers: Record<string, string> = {}) => {
    let req = (await w.as('accounts')).post(`/api/bank/statements/import-pdf?account_id=${accountId}`).set('Content-Type', 'application/pdf');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(body);
  };

  it('uses the saved password, or one typed for the occasion, and can remember it', async () => {
    const file = await pdf(WEEK);
    // The account's saved password opens it; every line is already here.
    const same = await upload(bank, file);
    expect(same.status).toBe(201);
    expect(same.body.data).toMatchObject({ rows_in_file: 6, imported: 0, already_present: 6 });

    // A new account with nothing saved: the statement needs its password.
    const third = (await (await w.as('accounts')).post('/api/accounting/accounts').send({ code: '1130', name: 'HDFC Current Account', type: 'asset', subtype: 'bank' }).expect(201)).body.data.id;
    const locked = await upload(third, file);
    expect(locked.status).toBe(422);
    expect(locked.body.error).toMatchObject({ code: 'statement_password_needed' });
    expect((await upload(third, file, { 'X-Statement-Password': 'nope' })).body.error).toMatchObject({ code: 'statement_password_wrong' });
    const typed = await upload(third, file, { 'X-Statement-Password': encodeURIComponent(PASSWORD), 'X-Remember-Password': 'yes' });
    expect(typed.status).toBe(201);
    expect(typed.body.data).toMatchObject({ imported: 6, already_present: 0 });
    // Remembered, locked, and not yet a rule for any mail.
    const feed = (await mailList()).feeds.find((f: any) => f.account_name === 'HDFC Current Account');
    expect(feed).toMatchObject({ has_password: true, active: false });
    expect((await upload(third, await pdf(NEXT))).status).toBe(201); // no password typed this time
    expect((await lines(third)).lines).toHaveLength(8);
  });

  it('turns away what is not a PDF, and people who may not import', async () => {
    expect((await upload(bank, Buffer.from('Date,Narration,Debit,Credit\n'))).status).toBe(400);
    expect((await upload(bank, Buffer.alloc(0))).status).toBe(400);
    const owner = await (await w.as('owner')).post(`/api/bank/statements/import-pdf?account_id=${bank}`).set('Content-Type', 'application/pdf').send(await pdf(WEEK));
    expect(owner.status).toBe(403);
  });

  it('leaves the books balanced', async () => {
    await expectBooksHealthy(w);
  });
});
