'use client';

import { istDate } from '@radcore/shared';
import { useState } from 'react';
import { CsvLink, ErrorBox, Loading, Page, Table, Toggle, date, inr, label } from '@/components/ui';
import { post, qs, useGet, useSaving } from '@/lib/api';
import { useCan } from '@/lib/session';

type JLine = { account_id: string; party_id: string; debit: string; credit: string };
const blank = (): JLine => ({ account_id: '', party_id: '', debit: '', credit: '' });

/** Day book, plus manual journals for opening balances and corrections. */
export default function JournalPage() {
  const can = useCan();
  const [f, setF] = useState({ from: '', to: '' });
  const path = `/accounting/journals${qs({ ...f, limit: 500 })}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Journal (day book)" actions={<CsvLink href={`/accounting/journals${qs(f)}`} />}>
      {can('accounts:write') && <Toggle label="+ Manual journal entry"><ManualJournal onDone={reload} /></Toggle>}
      <div className="filters">
        <label>From <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No entries yet." columns={[
        { key: 'entry_no', title: '#' }, { key: 'entry_date', title: 'Date', render: (r) => date(r.entry_date) },
        { key: 'ref_type', title: 'Source', render: (r) => `${label(r.ref_type)}${r.reverses_entry_id ? ' (reversal)' : ''}` },
        { key: 'narration', title: 'Narration', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.narration}</span> },
        { key: 'account_name', title: 'Account', render: (r) => `${r.account_code} ${r.account_name}` }, { key: 'party_name', title: 'Party' },
        { key: 'debit', title: 'Debit', align: 'right', render: (r) => (Number(r.debit) ? inr(r.debit) : '') },
        { key: 'credit', title: 'Credit', align: 'right', render: (r) => (Number(r.credit) ? inr(r.credit) : '') },
      ]} />
    </Page>
  );
}

function ManualJournal({ onDone }: { onDone: () => void }) {
  const saving = useSaving();
  const accounts = useGet<{ data: any[] }>('/accounting/accounts');
  const parties = useGet<{ data: any[] }>('/parties?limit=2000');
  const [entryDate, setEntryDate] = useState(istDate());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<JLine[]>([blank(), blank()]);
  const [error, setError] = useState<string | null>(null);
  const leaf = (accounts.data?.data ?? []).filter((a) => !a.is_group && a.active && a.system_key !== 'stock');
  const set = (i: number, patch: Partial<JLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);

  return (
    <div>
      <div className="form">
        <label><span>Date *</span><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></label>
        <label className="wide"><span>Narration *</span><input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="e.g. Opening balances as on 01-04-2026" /></label>
      </div>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>Account</th><th>Party (for Debtors / Creditors)</th><th className="right">Debit</th><th className="right">Credit</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><select value={l.account_id} onChange={(e) => set(i, { account_id: e.target.value })}><option value="">—</option>{leaf.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
              <td><select value={l.party_id} onChange={(e) => set(i, { party_id: e.target.value })}><option value="">—</option>{(parties.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
              <td className="right"><input type="number" min="0" step="any" style={{ width: 120 }} value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: '' })} /></td>
              <td className="right"><input type="number" min="0" step="any" style={{ width: 120 }} value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: '' })} /></td>
              <td>{lines.length > 2 && <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={2}><button type="button" onClick={() => setLines([...lines, blank()])}>+ Add line</button></td><td className="right">{inr(dr)}</td><td className="right">{inr(cr)}</td><td>{dr !== cr ? <span className="error small">Out by {inr(Math.abs(dr - cr))}</span> : null}</td></tr></tfoot>
      </table>
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" disabled={saving.busy} onClick={() => saving.run(async () => {
          setError(null);
          try {
            await post('/accounting/journals', {
              entry_date: entryDate, narration,
              lines: lines.filter((l) => l.account_id).map((l) => ({ account_id: l.account_id, party_id: l.party_id, debit: l.debit || '0', credit: l.credit || '0' })),
            });
            setNarration(''); setLines([blank(), blank()]);
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        })}>{saving.busy ? 'Saving…' : 'Post entry'}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
