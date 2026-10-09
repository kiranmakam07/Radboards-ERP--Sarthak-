'use client';

import { useState, type FormEvent } from 'react';
import { istDate } from '@radcore/shared';
import { ActionButton, CsvLink, ErrorBox, Loading, Page, Table, date, inr } from '@/components/ui';
import { api, post, useGet } from '@/lib/api';

/**
 * What was spent on advertising, by source and (if wanted) by campaign. The marketing dashboard
 * divides it by the leads that came in over the same days to give cost per lead.
 */
export default function AdSpendPage() {
  const { data, loading, error, reload } = useGet<{ data: any[]; campaign_names: any[] }>('/crm/spend');
  const sources = useGet<{ data: any[] }>('/masters/lead-sources');
  const [v, setV] = useState({ source_id: '', detail: '', spend_date: istDate(), amount: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: string, value: string) => setV((old) => ({ ...old, [k]: value }));
  // The campaign has to be spelled as it is on the leads, so offer the names that have actually come in.
  const names = (data?.campaign_names ?? []).filter((c) => c.source_id === v.source_id);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await post('/crm/spend', v);
      setV((old) => ({ ...old, amount: '', notes: '' }));
      reload();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Ad spend" actions={<CsvLink href="/crm/spend" />}>
      <p className="muted">Enter what was spent, per day or as one figure for a period. It is used only for cost per lead; the payment itself is still entered under Expenses.</p>
      <form className="form" onSubmit={save} style={{ marginBottom: 16 }}>
        <label><span>Source *</span>
          <select required value={v.source_id} onChange={(e) => setV({ ...v, source_id: e.target.value, detail: '' })}>
            <option value="">—</option>
            {(sources.data?.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label><span>Campaign</span>
          <select value={v.detail} onChange={(e) => set('detail', e.target.value)} disabled={!v.source_id}>
            <option value="">The source as a whole</option>
            {names.map((c) => <option key={c.detail} value={c.detail}>{c.detail}</option>)}
          </select>
          <small className="muted">Campaigns appear here once a lead has come in from them</small>
        </label>
        <label><span>Date *</span><input type="date" required value={v.spend_date} max={istDate()} onChange={(e) => set('spend_date', e.target.value)} /></label>
        <label><span>Amount spent *</span><input type="number" required min="0.01" step="any" value={v.amount} onChange={(e) => set('amount', e.target.value)} /></label>
        <label className="wide"><span>Note</span><textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <div className="form-foot">
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Add spend'}</button>
          <ErrorBox error={problem} />
        </div>
      </form>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No spend entered yet." columns={[
        { key: 'spend_date', title: 'Date', render: (r) => date(r.spend_date) },
        { key: 'source', title: 'Source' },
        { key: 'detail', title: 'Campaign', render: (r) => r.detail ?? <span className="muted">whole source</span> },
        { key: 'amount', title: 'Spent', align: 'right', render: (r) => inr(r.amount) },
        { key: 'notes', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.notes}</span> },
        { key: 'entered_by', title: 'Entered by' },
        { key: 'actions', title: '', render: (r) => <ActionButton onClick={() => api(`/crm/spend/${r.id}`, { method: 'DELETE' })} onDone={reload} confirm="Remove this entry?">Remove</ActionButton> },
      ]} />
    </Page>
  );
}
