'use client';

import { useState } from 'react';
import { fyOf, fyRange, istDate } from '@radcore/shared';
import { Badge, Card, CsvLink, ErrorBox, Loading, Page, Stat, Table, Toggle, date, inr, num } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** The form for a new challan: who it goes to, what for, and the material. */
function SendOut() {
  const workers = useGet<{ data: any[] }>('/parties?type=supplier&limit=2000');
  const items = useGet<{ data: any[] }>('/items?limit=2000');
  const places = useGet<{ data: any[] }>('/masters/locations');
  const [v, setV] = useState({ job_worker_id: '', from_location_id: '', challan_date: istDate(), process: '', expected_back_on: '', transport: '', notes: '' });
  const [lines, setLines] = useState<{ item_id: string; qty: string }[]>([{ item_id: '', qty: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = (places.data?.data ?? []).filter((l) => l.active && l.type !== 'job_work');
  const from = v.from_location_id || own.find((l) => l.type === 'stores')?.id || '';
  const stock = (items.data?.data ?? []).filter((i) => i.is_stock_item);
  const setLine = (i: number, patch: Partial<{ item_id: string; qty: string }>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const ready = v.job_worker_id && from && v.process.trim() && lines.some((l) => l.item_id && Number(l.qty) > 0);

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await post('/jobwork', { ...v, from_location_id: from, lines: lines.filter((l) => l.item_id && Number(l.qty) > 0) });
      window.location.href = `/jobwork/${res.data.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="form">
        <label><span>Job worker *</span>
          <select value={v.job_worker_id} onChange={(e) => setV({ ...v, job_worker_id: e.target.value })}>
            <option value="">—</option>{(workers.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <small className="muted">A job worker is added under Parties as a supplier</small>
        </label>
        <label><span>Sent from *</span>
          <select value={from} onChange={(e) => setV({ ...v, from_location_id: e.target.value })}>{own.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label><span>Challan date *</span><input type="date" value={v.challan_date} onChange={(e) => setV({ ...v, challan_date: e.target.value })} /></label>
        <label><span>What is to be done *</span><input value={v.process} placeholder="e.g. Powder coating" onChange={(e) => setV({ ...v, process: e.target.value })} /></label>
        <label><span>Expected back on</span><input type="date" value={v.expected_back_on} onChange={(e) => setV({ ...v, expected_back_on: e.target.value })} /></label>
        <label><span>Vehicle or transporter</span><input value={v.transport} onChange={(e) => setV({ ...v, transport: e.target.value })} /></label>
        <label className="wide"><span>Notes</span><textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
      </div>
      <h3>Material being sent</h3>
      {lines.map((l, i) => {
        const item = stock.find((x) => x.id === l.item_id);
        return (
          <div className="filters" key={i}>
            <select value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} aria-label="Item" className="grow">
              <option value="">Pick an item…</option>
              {stock.map((x) => <option key={x.id} value={x.id} disabled={lines.some((o, n) => n !== i && o.item_id === x.id)}>{x.sku} · {x.name} ({num(x.on_hand)} {x.unit} in stock)</option>)}
            </select>
            <input type="number" min="0" step="any" placeholder="Quantity" value={l.qty} style={{ width: 120 }} aria-label="Quantity" onChange={(e) => setLine(i, { qty: e.target.value })} />
            <span className="muted small">{item ? item.unit : ''}</span>
            {lines.length > 1 ? <button type="button" onClick={() => setLines(lines.filter((_, n) => n !== i))}>Remove</button> : null}
          </div>
        );
      })}
      <button type="button" onClick={() => setLines([...lines, { item_id: '', qty: '' }])}>+ Another item</button>
      <div className="form-foot">
        <button type="button" className="primary" disabled={!ready || busy} onClick={save}>{busy ? 'Saving…' : 'Make the challan and send'}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

/**
 * Job work: our material sent to an outside worker to be coated, welded, painted or made into
 * something, and tracked until every unit is back or accounted for. It stays ours while it is out.
 */
export default function JobWorkPage() {
  const can = useCan();
  const [status, setStatus] = useState('open');
  const path = `/jobwork${qs({ status })}`;
  const { data, loading, error } = useGet<{ data: any[]; totals: any }>(path);
  const year = fyRange(fyOf(istDate()));
  const [from, setFrom] = useState(year.from);
  const [to, setTo] = useState(istDate());
  const t = data?.totals;

  return (
    <Page title="Job work" actions={<CsvLink href={path} />}>
      <p className="muted">
        Material sent to an outside worker goes on a challan. It stays ours and stays in the books, but is no longer counted as on our shelves until it comes
        back: as it went, made into something else, or written off if it is lost.
      </p>
      {t && (
        <div className="stats">
          <Stat label="Challans out" value={t.open_challans} />
          <Stat label="Material still out" value={`₹${inr(t.value_out)}`} hint="at the value it was sent at" />
          <Stat label="Past the date expected back" value={t.late ? <span style={{ color: 'var(--danger)' }}>{t.late}</span> : 0} />
        </div>
      )}
      {can('jobwork:write') && <Toggle label="+ Send material out"><SendOut /></Toggle>}
      <div className="filters">
        {[['open', 'Out now'], ['closed', 'All back'], ['cancelled', 'Cancelled'], ['', 'All']].map(([s, l]) => (
          <button key={s} type="button" className={status === s ? 'primary' : undefined} onClick={() => setStatus(s!)}>{l}</button>
        ))}
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty={status === 'open' ? 'Nothing is out with a job worker.' : 'No challans.'} rowHref={(r) => `/jobwork/${r.id}`} columns={[
        { key: 'challan_no', title: 'Challan' },
        { key: 'challan_date', title: 'Sent', render: (r) => date(r.challan_date) },
        { key: 'job_worker_name', title: 'Job worker' },
        { key: 'process', title: 'For', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.process}</span> },
        { key: 'still_out', title: 'Still out', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.still_out}</span> },
        { key: 'out_value', title: 'Value out', align: 'right', render: (r) => (Number(r.out_value) ? inr(r.out_value) : '') },
        { key: 'expected_back_on', title: 'Expected back', render: (r) => (r.expected_back_on ? <span className={r.late ? 'error small' : undefined}>{date(r.expected_back_on)}{r.late ? ' · late' : ''}</span> : '') },
        { key: 'days_out', title: 'Days out', align: 'right', render: (r) => (r.status === 'open' ? <span className={r.past_one_year ? 'error small' : undefined}>{r.days_out}</span> : '') },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status === 'closed' ? 'all_back' : r.status === 'open' ? 'out' : r.status} /> },
      ]} />

      <Card title="For the GST job work return (ITC-04)">
        <p className="muted small">
          Two lists for the dates you choose: what was sent out, and what came back, was made from it, or was lost. The return is filled from these;
          this is not the file the portal takes. Material sent for job work has to be back within a year of its challan.
        </p>
        <div className="filters">
          <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <a className="button" href={`/api/jobwork/register${qs({ kind: 'sent', from, to, format: 'xlsx' })}`}>Sent out (Excel)</a>
          <a className="button" href={`/api/jobwork/register${qs({ kind: 'received', from, to, format: 'xlsx' })}`}>Came back (Excel)</a>
        </div>
      </Card>
    </Page>
  );
}
