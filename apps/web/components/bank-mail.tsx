'use client';

import { useEffect, useRef, useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, Form, Notice, Table, Toggle, date, label } from '@/components/ui';
import { post, put, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'never');
/** How long since the mailbox was read before opening the screen reads it again. */
const STALE_MS = 30 * 60_000;

/**
 * Statement import, for a file chosen here: a CSV as before, or the PDF the bank emails. A locked
 * PDF is opened with the password saved for the account; when there is none, or it is wrong, the
 * password is asked for and can be remembered.
 */
export function ImportStatement({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<any | null>(null);
  const [locked, setLocked] = useState<{ file: File; wrong: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const mail = useGet<{ data: any }>('/bank/mail');
  const canSave = mail.data?.data.can_save_password;

  async function sendPdf(file: File, typed?: string) {
    const res = await fetch(`/api/bank/statements/import-pdf?account_id=${accountId}`, {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: {
        'Content-Type': 'application/pdf',
        ...(typed ? { 'X-Statement-Password': encodeURIComponent(typed), ...(remember && canSave ? { 'X-Remember-Password': 'yes' } : {}) } : {}),
      },
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return json.data;
    const code = json?.error?.code;
    if (code === 'statement_password_needed' || code === 'statement_password_wrong') {
      setLocked({ file, wrong: code === 'statement_password_wrong' });
      return null;
    }
    throw Object.assign(new Error(json?.error?.message ?? `The import failed (${res.status})`), { details: json?.error?.details });
  }

  async function run(work: () => Promise<any>) {
    setBusy(true); setError(null); setImported(null);
    try {
      const result = await work();
      if (result) {
        setImported(result);
        setLocked(null);
        setPassword('');
        onDone();
        mail.reload();
      }
    } catch (e) {
      const details = (e as any).details?.errors as { row: number; message: string }[] | undefined;
      setError(`${(e as Error).message}${details ? ` ${details.slice(0, 5).map((d) => `Row ${d.row}: ${d.message}.`).join(' ')}` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  function choose(file: File | undefined) {
    if (!file) return;
    setLocked(null);
    const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    void run(async () => (pdf ? sendPdf(file) : (await post('/bank/statements/import', { account_id: accountId, csv: await file.text() })).data));
  }

  return (
    <Card title="Import a bank statement">
      <p className="muted small">
        Choose the statement the bank emailed (the PDF, locked or not) or one downloaded from the bank as CSV. Importing the same days twice is safe:
        lines already here are skipped.
      </p>
      <input type="file" accept=".pdf,application/pdf,.csv,text/csv,text/plain" disabled={busy} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
      {busy && <span className="muted"> Reading…</span>}
      {locked && (
        <div className="form inline" style={{ marginTop: 10 }}>
          <label>
            <span>{locked.wrong ? 'That password did not open it. The password for this statement' : 'This statement is locked. Its password'}</span>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && password) void run(() => sendPdf(locked.file, password)); }} />
          </label>
          {canSave ? (
            <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>Remember it for this account</span></label>
          ) : null}
          <div className="form-foot">
            <button type="button" className="primary" disabled={busy || !password} onClick={() => run(() => sendPdf(locked.file, password))}>Open and import</button>
            <button type="button" onClick={() => { setLocked(null); setPassword(''); }}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {imported && (
        <Notice>
          {imported.imported} line(s) imported for {date(imported.from)} to {date(imported.to)}; {imported.already_present} were already here;{' '}
          {imported.auto_matched} matched automatically.
        </Notice>
      )}
    </Card>
  );
}

/**
 * Statements that come by email: the bank's mail is forwarded to a mailbox kept for this, the app
 * reads it, and each statement goes through the same import as one chosen by hand.
 */
export function StatementsByEmail({ accountId, onImported }: { accountId: string; onImported: () => void }) {
  const can = useCan();
  const write = can('accounts:write');
  const { data, error, reload } = useGet<{ data: any }>('/bank/mail');
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const asked = useRef(false);
  const d = data?.data;

  async function check(quiet = false) {
    setChecking(true);
    if (!quiet) setNote(null);
    try {
      const r = (await post('/bank/mail/check')).data;
      if (!quiet || r.found > 0) {
        setNote(r.error ? null : r.found === 0 ? 'Nothing new in the mailbox.'
          : `${r.found} new mail(s): ${r.imported} statement(s) imported, ${r.failed} could not be imported, ${r.ignored} left alone.`);
      }
      reload();
      if (r.imported > 0) onImported();
    } catch (e) {
      if (!quiet) setNote((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  // Opening the screen reads the mailbox when it has not been read for a while. A scheduler on the server can do the same.
  useEffect(() => {
    if (!d || asked.current || !write || !d.configured) return;
    const last = d.state.last_checked_at ? Date.parse(d.state.last_checked_at) : 0;
    if (Date.now() - last > STALE_MS) {
      asked.current = true;
      void check(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, write]);

  if (error) return <Card title="Statements by email"><ErrorBox error={error} /></Card>;
  if (!d) return null;
  const feed = d.feeds.find((f: any) => f.account_id === accountId);
  const waiting = d.mails.filter((x: any) => x.status === 'failed').length;

  return (
    <Card title="Statements by email" actions={write && d.configured ? <button type="button" disabled={checking} onClick={() => check()}>{checking ? 'Reading the mailbox…' : 'Check the mailbox now'}</button> : null}>
      {d.configured ? (
        <p className="muted small">
          Reading <strong>{d.mailbox}</strong>. Forward the bank&apos;s statement mails there, and each statement is imported by itself. Last read: {when(d.state.last_checked_at)}.
        </p>
      ) : (
        <p className="muted small">
          No mailbox is connected yet. When the mailbox for statements has been created, its address and app password are set on the server, and the
          statements forwarded to it are then imported by themselves. Until then, choose the PDF above. The rule and the password below can be set already.
        </p>
      )}
      <ErrorBox error={d.state.last_error} />
      <Notice>{note}</Notice>
      {waiting > 0 ? <p className="error small">{waiting} statement(s) could not be imported. See why below.</p> : null}

      {write && feed && (
        <Toggle label={feed.set_up ? `How ${feed.account_name}'s statement mails are recognised` : `Set up ${feed.account_name} for statements by email`} open={!feed.set_up && d.configured}>
          <p className="muted small">
            A mail is taken as this account&apos;s statement only when the sender&apos;s address and the subject contain these words, so nothing else that reaches the
            mailbox is touched. {feed.has_password ? 'A password is saved; leave the box empty to keep it.' : 'The password is the one the bank set for opening the statement.'}
            {d.can_save_password ? '' : ' A password cannot be saved until APP_SECRET is set on the server.'}
          </p>
          <Form key={`${feed.account_id}-${feed.match_from}-${feed.match_subject}-${feed.has_password}-${feed.active}`} submit="Save"
            initial={{ match_from: feed.match_from ?? '', match_subject: feed.match_subject ?? '', password: '', active: feed.set_up ? feed.active : true }}
            fields={[
              { name: 'match_from', label: 'The sender’s address contains', placeholder: 'e.g. idfcfirstbank.com' },
              { name: 'match_subject', label: 'The subject contains', placeholder: 'e.g. account statement' },
              { name: 'password', label: feed.has_password ? 'New statement password' : 'Statement password', type: 'password', help: feed.has_password ? 'Saved. Leave empty to keep it' : undefined },
              { name: 'active', label: 'Import this account’s statements from the mailbox', type: 'checkbox' },
            ]}
            onSubmit={(v) => put(`/bank/mail/feeds/${feed.account_id}`, v)} onDone={reload} />
        </Toggle>
      )}

      <Table rows={d.mails} empty="No mail has been read yet." columns={[
        { key: 'received_at', title: 'Received', render: (x) => when(x.received_at ?? x.created_at) },
        { key: 'from_address', title: 'From', render: (x) => <span style={{ whiteSpace: 'normal' }}>{x.from_address}</span> },
        { key: 'subject', title: 'Subject', render: (x) => <span style={{ whiteSpace: 'normal' }}>{x.subject}{x.attachment_name ? <span className="muted small"> · {x.attachment_name}</span> : null}</span> },
        { key: 'account_name', title: 'Account' },
        { key: 'status', title: 'What happened', render: (x) => (
          <span style={{ whiteSpace: 'normal' }}>
            <Badge value={x.status === 'ignored' ? 'left_alone' : x.status} /> <span className={x.status === 'failed' ? 'error small' : 'small muted'}>{x.detail}</span>
          </span>
        ) },
        { key: 'x', title: '', render: (x) => (write && x.status === 'failed' ? (
          <span className="actions">
            {x.can_retry ? <ActionButton onClick={() => post(`/bank/mail/${x.id}/retry`)} onDone={() => { reload(); onImported(); }}>Try again</ActionButton> : null}
            <ActionButton onClick={() => post(`/bank/mail/${x.id}/dismiss`)} onDone={reload}>Set aside</ActionButton>
          </span>
        ) : null) },
      ]} />
      {d.mails.length > 0 ? <p className="muted small">The last {d.mails.length} mails. “{label('left_alone')}” means the mail was not a statement for any account here, and nothing was done with it.</p> : null}
    </Card>
  );
}
