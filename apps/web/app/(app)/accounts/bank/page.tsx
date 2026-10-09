'use client';

import { useEffect, useState } from 'react';
import { ActionButton, Badge, Card, CsvLink, ErrorBox, Loading, Notice, Page, Stat, Table, date, inr, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * Bank reconciliation (PRD 7.8): import the bank's statement, see which lines the books
 * already explain, and deal with the rest - match by hand, or book the missing entry.
 */
export default function BankPage() {
  const can = useCan();
  const write = can('accounts:write');
  const accounts = useGet<{ data: any[] }>('/bank/accounts');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('unmatched');
  const [imported, setImported] = useState<any | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<string | null>(null);
  const [combining, setCombining] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.data?.data[0]) setAccountId(accounts.data.data[0].id);
  }, [accounts.data, accountId]);

  const path = accountId ? `/bank/reconciliation${qs({ account_id: accountId, status })}` : null;
  const { data, loading, error, reload } = useGet<{ data: any }>(path);
  const r = data?.data;
  const refresh = () => { reload(); accounts.reload(); setBooking(null); setCombining(null); };

  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setImportError(null); setImported(null);
    try {
      const res = await post('/bank/statements/import', { account_id: accountId, csv: await file.text() });
      setImported(res.data);
      refresh();
    } catch (e) {
      const details = (e as any).details?.errors as { row: number; message: string }[] | undefined;
      setImportError(`${(e as Error).message}${details ? ` ${details.slice(0, 5).map((d) => `Row ${d.row}: ${d.message}.`).join(' ')}` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Bank reconciliation" actions={path ? <CsvLink href={`/bank/reconciliation${qs({ account_id: accountId })}`} /> : null}>
      <Loading loading={accounts.loading} error={accounts.error} />
      <div className="filters">
        <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setImported(null); }}>
          {(accounts.data?.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}{a.unmatched_lines ? ` (${a.unmatched_lines} to reconcile)` : ''}</option>)}
        </select>
        {['unmatched', 'matched', 'ignored', ''].map((s) => (
          <button key={s} type="button" className={status === s ? 'primary' : undefined} onClick={() => setStatus(s)}>{s ? label(s) : 'All lines'}</button>
        ))}
      </div>

      {write && accountId && (
        <Card title="Import a bank statement">
          <p className="muted small">Download the statement from the bank as CSV and choose the file. Importing the same period twice is safe: lines already here are skipped.</p>
          <input type="file" accept=".csv,text/csv,text/plain" disabled={busy} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
          {busy && <span className="muted"> Importing…</span>}
          <ErrorBox error={importError} />
          {imported && (
            <Notice>
              {imported.imported} line(s) imported for {date(imported.from)} to {date(imported.to)}; {imported.already_present} were already here;{' '}
              {imported.auto_matched} matched automatically.
            </Notice>
          )}
        </Card>
      )}

      <Loading loading={loading} error={error} />
      {r && (
        <>
          <div className="stats">
            <Stat label="Balance in our books" value={`₹${inr(r.summary.book_balance)}`} />
            <Stat label="Balance on the statement" value={r.summary.statement_balance === null ? '—' : `₹${inr(r.summary.statement_balance)}`}
              hint={r.summary.statement_balance_date ? `as of ${date(r.summary.statement_balance_date)}` : 'the file had no balance column'} />
            <Stat label="Statement lines to reconcile" value={r.summary.unmatched_statement_lines}
              hint={`in ₹${inr(r.summary.unmatched_statement_in)} · out ₹${inr(r.summary.unmatched_statement_out)}`} />
            <Stat label="Book entries not on the statement" value={r.summary.unmatched_book_entries} hint={`net ₹${inr(r.summary.unmatched_book_total)}`} />
          </div>

          <Card title="Statement lines" actions={write ? (
            <ActionButton onClick={() => post('/bank/auto-match', { account_id: accountId })} onDone={refresh}>Run automatic matching</ActionButton>
          ) : null}>
            <Table rows={r.lines} empty={status === 'unmatched' ? 'Nothing left to reconcile.' : 'No statement lines.'} columns={[
              { key: 'txn_date', title: 'Date', render: (l) => date(l.txn_date) },
              { key: 'description', title: 'Bank description', render: (l) => <span style={{ whiteSpace: 'normal' }}>{l.description}{l.reference ? <span className="muted small"> · {l.reference}</span> : null}</span> },
              { key: 'in', title: 'In', align: 'right', render: (l) => (Number(l.amount) > 0 ? inr(l.amount) : '') },
              { key: 'out', title: 'Out', align: 'right', render: (l) => (Number(l.amount) < 0 ? inr(Math.abs(Number(l.amount))) : '') },
              { key: 'status', title: 'Status', render: (l) => (
                <span style={{ whiteSpace: 'normal' }}>
                  <Badge value={l.status === 'unmatched' ? 'pending' : l.status === 'matched' ? 'approved' : 'closed'} />
                  {l.status === 'matched' && l.matches.length === 1 && <span className="small muted"> {label(l.matches[0].ref_type)} · {date(l.matches[0].entry_date)} · {l.matches[0].narration}</span>}
                  {l.status === 'matched' && l.matches.length > 1 && (
                    <span className="small muted"> {l.matches.length} entries: {l.matches.map((x: any) => `${label(x.ref_type)} ${Number(x.amount) < 0 ? '−' : ''}₹${inr(Math.abs(Number(x.amount)))}`).join(', ')}</span>
                  )}
                  {l.status === 'ignored' && <span className="small muted"> {l.ignore_reason}</span>}
                </span>
              ) },
              { key: 'x', title: '', render: (l) => (!write ? null : l.status === 'matched' ? (
                <ActionButton onClick={() => post(`/bank/lines/${l.id}/unmatch`)} onDone={refresh}>Unmatch</ActionButton>
              ) : l.status === 'ignored' ? (
                <ActionButton onClick={() => post(`/bank/lines/${l.id}/unignore`)} onDone={refresh}>Bring back</ActionButton>
              ) : (
                <span className="actions">
                  <MatchPicker line={l} entries={r.unmatched_book_entries} onDone={refresh} />
                  <button type="button" onClick={() => { setCombining(combining === l.id ? null : l.id); setBooking(null); }}>{combining === l.id ? '× Close' : 'Several entries…'}</button>
                  <button type="button" onClick={() => { setBooking(booking === l.id ? null : l.id); setCombining(null); }}>{booking === l.id ? '× Close' : 'Book it…'}</button>
                  <ActionButton onClick={async () => {
                    const reason = window.prompt('Why should this line be set aside?');
                    if (reason) await post(`/bank/lines/${l.id}/ignore`, { reason });
                  }} onDone={refresh}>Set aside</ActionButton>
                </span>
              )) },
            ]} />
            {combining && r.lines.some((l: any) => l.id === combining) && (
              <MatchSeveral key={combining} line={r.lines.find((l: any) => l.id === combining)} entries={r.unmatched_book_entries} onDone={refresh} />
            )}
            {booking && r.lines.some((l: any) => l.id === booking) && (
              <BookEntry line={r.lines.find((l: any) => l.id === booking)} accountId={accountId} onDone={refresh} />
            )}
          </Card>

          <Card title="In our books but not on the statement">
            <Table rows={r.unmatched_book_entries} empty="Every book entry on this account is matched." columns={[
              { key: 'entry_date', title: 'Date', render: (e) => date(e.entry_date) },
              { key: 'ref_type', title: 'Type', render: (e) => label(e.ref_type) },
              { key: 'narration', title: 'Narration', render: (e) => <span style={{ whiteSpace: 'normal' }}>{e.narration}</span> },
              { key: 'party_name', title: 'Party' },
              { key: 'in', title: 'In', align: 'right', render: (e) => (Number(e.amount) > 0 ? inr(e.amount) : '') },
              { key: 'out', title: 'Out', align: 'right', render: (e) => (Number(e.amount) < 0 ? inr(Math.abs(Number(e.amount))) : '') },
            ]} />
          </Card>
        </>
      )}
    </Page>
  );
}

/** Offers only the book entries of exactly the same amount: nothing else could be this line. */
function MatchPicker({ line, entries, onDone }: { line: any; entries: any[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const same = entries.filter((e) => Number(e.amount) === Number(line.amount));
  if (same.length === 0) return <span className="muted small">no entry of this amount</span>;
  return (
    <span className="action">
      <select value="" onChange={async (e) => {
        if (!e.target.value) return;
        setError(null);
        try {
          await post(`/bank/lines/${line.id}/match`, { journal_line_id: Number(e.target.value) });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}>
        <option value="">Match to…</option>
        {same.map((e) => <option key={e.journal_line_id} value={e.journal_line_id}>{date(e.entry_date)} · {label(e.ref_type)} · {e.party_name ?? e.narration}</option>)}
      </select>
      {error ? <span className="error small">{error}</span> : null}
    </span>
  );
}

/**
 * One bank line that stands for several book entries: a card-machine or payment-gateway payout
 * covering a day's receipts. Tick the entries; they must add up to the line. If the bank paid
 * less because it kept its fee, pick where the fee goes and it is booked along with the match.
 */
function MatchSeveral({ line, entries, onDone }: { line: any; entries: any[]; onDone: () => void }) {
  const categories = useGet<{ data: any[] }>('/masters/expense-categories');
  const [picked, setPicked] = useState<number[]>([]);
  const [fee, setFee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moneyIn = Number(line.amount) > 0;
  // Receipts for money in, payments for money out; a fee already in the books can be part of either.
  const offered = entries.filter((e) => (moneyIn ? Number(e.amount) > 0 : Number(e.amount) < 0) || picked.includes(e.journal_line_id));
  const total = entries.filter((e) => picked.includes(e.journal_line_id)).reduce((sum, e) => sum + Number(e.amount), 0);
  const short = Math.round((total - Number(line.amount)) * 100) / 100;
  const toggle = (id: number) => setPicked((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post(`/bank/lines/${line.id}/match`, { journal_line_ids: picked, fee_category_id: short > 0 ? fee : '' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toggle-body" style={{ marginTop: 10 }}>
      <p style={{ marginTop: 0 }}>
        <strong>{date(line.txn_date)} · {moneyIn ? 'received' : 'paid out'} ₹{inr(Math.abs(Number(line.amount)))}</strong>{' '}
        <span className="muted">{line.description}</span>
      </p>
      <p className="muted small">Tick the book entries this one line covers.</p>
      <Table rows={offered} empty="No book entries on this account are waiting to be matched." columns={[
        { key: 'pick', title: '', render: (e) => <input type="checkbox" checked={picked.includes(e.journal_line_id)} onChange={() => toggle(e.journal_line_id)} aria-label={`Include ${e.narration ?? 'entry'}`} style={{ width: 'auto' }} /> },
        { key: 'entry_date', title: 'Date', render: (e) => date(e.entry_date) },
        { key: 'ref_type', title: 'Type', render: (e) => label(e.ref_type) },
        { key: 'party_name', title: 'Party / narration', render: (e) => <span style={{ whiteSpace: 'normal' }}>{e.party_name ?? e.narration}{e.payment_reference ? <span className="muted small"> · {e.payment_reference}</span> : null}</span> },
        { key: 'amount', title: 'Amount', align: 'right', render: (e) => inr(e.amount) },
      ]} />
      <p>
        Ticked: <strong>₹{inr(total)}</strong> of ₹{inr(line.amount)} on the statement.{' '}
        {picked.length === 0 ? null : short === 0 ? <span className="badge green">Adds up</span>
          : short > 0 ? <span className="badge amber">The bank paid ₹{inr(short)} less</span>
          : <span className="badge red">₹{inr(Math.abs(short))} short of the statement</span>}
      </p>
      {short > 0 && (
        <div className="form">
          <label><span>Book the ₹{inr(short)} the bank kept as *</span>
            <select value={fee} onChange={(e) => setFee(e.target.value)}>
              <option value="">—</option>
              {(categories.data?.data ?? []).filter((c) => c.active !== false).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="form-foot">
        <button type="button" className="primary" disabled={busy || picked.length === 0 || short < 0 || (short > 0 && !fee)} onClick={save}>
          {short > 0 ? 'Book the fee and match' : `Match ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'}`}
        </button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

/** The bank shows something the books do not have: create the entry, dated as on the statement, and match it. */
function BookEntry({ line, accountId, onDone }: { line: any; accountId: string; onDone: () => void }) {
  const out = Number(line.amount) < 0;
  const categories = useGet<{ data: any[] }>('/masters/expense-categories');
  const parties = useGet<{ data: any[] }>('/parties?limit=2000');
  const accounts = useGet<{ data: any[] }>('/accounting/accounts');
  const [kind, setKind] = useState(out ? 'expense' : 'party');
  const [target, setTarget] = useState('');
  const [narration, setNarration] = useState('');
  const [error, setError] = useState<string | null>(null);
  const others = (accounts.data?.data ?? []).filter((a) => !a.is_group && a.active && !['debtors', 'creditors', 'stock'].includes(a.system_key) && a.id !== accountId);

  async function save() {
    setError(null);
    try {
      const body = kind === 'expense' ? { kind, category_id: target }
        : kind === 'party' ? { kind, party_id: target }
        : { kind, account_id: target, narration };
      await post(`/bank/lines/${line.id}/create-entry`, body);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="toggle-body" style={{ marginTop: 10 }}>
      <p style={{ marginTop: 0 }}>
        <strong>{date(line.txn_date)} · {out ? 'paid out' : 'received'} ₹{inr(Math.abs(Number(line.amount)))}</strong>{' '}
        <span className="muted">{line.description}</span>
      </p>
      <div className="form">
        <label><span>Book it as</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setTarget(''); }}>
            {out && <option value="expense">An expense (bank charges, rent…)</option>}
            <option value="party">{out ? 'A payment to a party' : 'A receipt from a party'}</option>
            <option value="journal">Something else (interest, transfer, capital…)</option>
          </select>
        </label>
        <label><span>{kind === 'expense' ? 'Expense category' : kind === 'party' ? 'Party' : 'Other account'} *</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">—</option>
            {kind === 'expense' && (categories.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {kind === 'party' && (parties.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.party_type})</option>)}
            {kind === 'journal' && others.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </label>
        {kind === 'journal' && <label className="wide"><span>What it is *</span><input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="e.g. Savings account interest" /></label>}
        {kind === 'party' && <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>Saved as an advance; set it against invoices or bills from Payments.</p>}
        <div className="form-foot"><button type="button" className="primary" disabled={!target} onClick={save}>Create entry and match</button><ErrorBox error={error} /></div>
      </div>
    </div>
  );
}
