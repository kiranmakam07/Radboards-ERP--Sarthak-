'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { istDate } from '@radcore/shared';
import { ActionButton, Badge, Card, ErrorBox, Form, KV, Loading, Page, Table, Toggle, date, inr, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const WHAT: Record<string, string> = { returned: 'Came back', produced: 'Made', consumed: 'Used to make it', lost: 'Lost' };

/** What came back on one occasion: for each thing sent, how much is back, used up or lost; and what was made. */
function Receive({ job, onDone }: { job: any; onDone: () => void }) {
  const items = useGet<{ data: any[] }>('/items?limit=2000');
  const places = useGet<{ data: any[] }>('/masters/locations');
  const pending = job.lines.filter((l: any) => Number(l.pending) > 0);
  const [v, setV] = useState({ received_on: istDate(), to_location_id: '', worker_challan_no: '', charge: '', notes: '', made_item: '', made_qty: '' });
  const [rows, setRows] = useState<Record<string, { returned?: string; consumed?: string; lost?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = (places.data?.data ?? []).filter((l) => l.active && l.type !== 'job_work');
  const to = v.to_location_id || job.from_location_id;
  const set = (id: string, k: 'returned' | 'consumed' | 'lost', value: string) => setRows({ ...rows, [id]: { ...rows[id], [k]: value } });
  const used = pending.some((l: any) => Number(rows[l.id]?.consumed) > 0);
  const stock = (items.data?.data ?? []).filter((i) => i.is_stock_item);

  async function save() {
    setBusy(true); setError(null);
    try {
      await post(`/jobwork/${job.id}/receipts`, {
        received_on: v.received_on, to_location_id: to, worker_challan_no: v.worker_challan_no, charge: v.charge, notes: v.notes,
        lines: pending.map((l: any) => ({ line_id: l.id, ...rows[l.id] })).filter((l: any) => Number(l.returned) > 0 || Number(l.consumed) > 0 || Number(l.lost) > 0),
        produced: v.made_qty ? { item_id: v.made_item, qty: v.made_qty } : null,
      });
      setRows({}); setV({ ...v, worker_challan_no: '', charge: '', notes: '', made_item: '', made_qty: '' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const box = (l: any, k: 'returned' | 'consumed' | 'lost') => (
    <input type="number" min="0" step="any" style={{ width: 96 }} value={rows[l.id]?.[k] ?? ''} aria-label={`${l.name}: ${k}`} onChange={(e) => set(l.id, k, e.target.value)} />
  );

  return (
    <div>
      <div className="form">
        <label><span>Date *</span><input type="date" value={v.received_on} onChange={(e) => setV({ ...v, received_on: e.target.value })} /></label>
        <label><span>Taken into *</span>
          <select value={to} onChange={(e) => setV({ ...v, to_location_id: e.target.value })}>{own.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label><span>Job worker&apos;s challan number</span><input value={v.worker_challan_no} onChange={(e) => setV({ ...v, worker_challan_no: e.target.value })} /></label>
      </div>
      <Table rows={pending} columns={[
        { key: 'name', title: 'Sent', render: (l) => <>{l.name} <span className="muted small">{l.sku}</span></> },
        { key: 'pending', title: 'Still out', align: 'right', render: (l) => `${num(l.pending)} ${l.unit}` },
        { key: 'returned', title: 'Came back as it is', align: 'right', render: (l) => box(l, 'returned') },
        { key: 'consumed', title: 'Used to make something', align: 'right', render: (l) => box(l, 'consumed') },
        { key: 'lost', title: 'Lost, will not come back', align: 'right', render: (l) => box(l, 'lost') },
      ]} />
      {used && (
        <div className="form">
          <label><span>What was made from it *</span>
            <select value={v.made_item} onChange={(e) => setV({ ...v, made_item: e.target.value })}>
              <option value="">Pick an item…</option>{stock.map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.name}</option>)}
            </select>
            <small className="muted">It comes into stock worth what was used to make it</small>
          </label>
          <label><span>How many *</span><input type="number" min="0" step="any" value={v.made_qty} onChange={(e) => setV({ ...v, made_qty: e.target.value })} /></label>
        </div>
      )}
      <div className="form">
        <label><span>Job charge for this lot ₹</span><input type="number" min="0" step="any" value={v.charge} onChange={(e) => setV({ ...v, charge: e.target.value })} />
          <small className="muted">Before GST. Leave empty to keep it out of the cost of the goods; it is then an expense when the bill is booked</small></label>
        <label className="wide"><span>Notes</span><textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
      </div>
      <div className="form-foot">
        <button type="button" className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Record it'}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

/** One job work challan: what went, what is back, what is still out, and the job worker's bill. */
export default function JobWorkChallanPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const write = can('jobwork:write');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/jobwork/${id}`);
  const services = useGet<{ data: any[] }>(can('bills:write') ? '/items?type=service&limit=500' : null);
  const j = data?.data;
  if (!j) return <Page title="Job work challan"><Loading loading={loading} error={error} /></Page>;
  const standing = j.receipts.filter((r: any) => r.status === 'posted');
  const late = j.status === 'open' && j.expected_back_on && j.expected_back_on < istDate();
  const pastYear = j.status === 'open' && j.due_back_by < istDate();

  return (
    <Page title={`Job work ${j.challan_no}`} actions={
      <>
        <Link className="button primary" href={`/jobwork/${id}/print`}>Print the challan</Link>
        {write && j.status === 'open' && standing.length === 0 ? (
          <ActionButton kind="danger" onDone={reload} onClick={async () => {
            const reason = window.prompt('Why is this challan being cancelled? The material goes back to where it was sent from.');
            if (reason) await post(`/jobwork/${id}/cancel`, { reason });
          }}>Cancel the challan</ActionButton>
        ) : null}
      </>
    }>
      <Card>
        <KV rows={[
          ['Status', <Badge value={j.status === 'closed' ? 'all_back' : j.status === 'open' ? 'out' : j.status} />],
          ['Job worker', <Link href={`/parties/${j.job_worker_id}`}>{j.job_worker_name}</Link>],
          ['For', j.process],
          ['Sent on', `${date(j.challan_date)} from ${j.from_location}`],
          ['Expected back', j.expected_back_on ? <span className={late ? 'error' : undefined}>{date(j.expected_back_on)}{late ? ' (late)' : ''}</span> : null],
          ['Must be back by', j.status === 'open' ? <span className={pastYear ? 'error' : undefined}>{date(j.due_back_by)} <span className="muted small">(a year from the challan, under GST){pastYear ? ' · passed' : ''}</span></span> : null],
          ['Out for', j.status === 'open' ? `${j.days_out} day(s)` : null],
          ['Still out', Number(j.out_value) ? `₹${inr(j.out_value)} at the value it was sent at` : null],
          ['Vehicle or transporter', j.transport], ['Notes', j.notes],
        ]} />
      </Card>

      <Card title="What was sent">
        <Table rows={j.lines} columns={[
          { key: 'name', title: 'Item', render: (l) => <>{l.name} <span className="muted small">{l.sku}</span></> },
          { key: 'qty', title: 'Sent', align: 'right', render: (l) => `${num(l.qty)} ${l.unit}` },
          { key: 'returned', title: 'Came back', align: 'right', render: (l) => (Number(l.returned) ? num(l.returned) : '') },
          { key: 'consumed', title: 'Used up', align: 'right', render: (l) => (Number(l.consumed) ? num(l.consumed) : '') },
          { key: 'lost', title: 'Lost', align: 'right', render: (l) => (Number(l.lost) ? <span className="error small">{num(l.lost)}</span> : '') },
          { key: 'pending', title: 'Still out', align: 'right', render: (l) => (Number(l.pending) ? <strong>{num(l.pending)}</strong> : '') },
          { key: 'value', title: 'Value sent', align: 'right', render: (l) => inr(l.value) },
        ]} />
      </Card>

      {write && j.status === 'open' && (
        <Card title="Record what came back">
          <p className="muted small">
            Each time something comes back, say what happened to the material: it came back as it went, it was used to make something else, or it is lost.
            The challan closes by itself once every unit is accounted for.
          </p>
          <Receive key={j.receipts.length} job={j} onDone={reload} />
        </Card>
      )}

      <Card title="What has come back">
        <Table rows={j.receipts} empty="Nothing has come back yet." columns={[
          { key: 'receipt_no', title: 'Number' }, { key: 'received_on', title: 'Date', render: (r) => date(r.received_on) },
          { key: 'to_location', title: 'Into' }, { key: 'worker_challan_no', title: 'Their challan' },
          { key: 'lines', title: 'What', render: (r) => (
            <span style={{ whiteSpace: 'normal' }}>
              {r.lines.map((l: any, i: number) => <span key={i}>{i ? '; ' : ''}{WHAT[l.kind]}: {num(l.qty)} {l.unit} {l.item}{l.kind === 'produced' ? ` (₹${inr(l.value)})` : ''}</span>)}
            </span>
          ) },
          { key: 'charge', title: 'Charge added', align: 'right', render: (r) => (Number(r.charge) ? inr(r.charge) : '') },
          { key: 'status', title: '', render: (r) => (r.status === 'cancelled' ? <Badge value="cancelled" /> : null) },
          { key: 'x', title: '', render: (r) => (write && r.status === 'posted' ? (
            <ActionButton onDone={reload} onClick={async () => {
              const reason = window.prompt('Why is this being undone? The goods go back to being with the job worker.');
              if (reason) await post(`/jobwork/receipts/${r.id}/cancel`, { reason });
            }}>Undo</ActionButton>
          ) : null) },
        ]} />
      </Card>

      <Card title="The job worker's bill">
        {Number(j.charges.added_to_cost) > 0 ? (
          <p className="small">
            ₹{inr(j.charges.added_to_cost)} of job charges has been added to the cost of the goods; ₹{inr(j.charges.billed)} of it has been billed.{' '}
            {Number(j.charges.still_to_bill) > 0 ? <strong>₹{inr(j.charges.still_to_bill)} is still waiting for the bill.</strong> : 'Nothing is waiting.'}
          </p>
        ) : <p className="muted small">No job charge has been added to the cost of the goods on this challan. A bill booked here is then an ordinary expense.</p>}
        <Table rows={j.bills} empty="No bill has been booked against this challan." rowHref={(b) => `/purchasing/bills/${b.id}`} columns={[
          { key: 'bill_no', title: 'Bill' }, { key: 'supplier_invoice_no', title: 'Their invoice' }, { key: 'bill_date', title: 'Date', render: (b) => date(b.bill_date) },
          { key: 'taxable_total', title: 'Before GST', align: 'right', render: (b) => inr(b.taxable_total) },
          { key: 'grand_total', title: 'Total', align: 'right', render: (b) => inr(b.grand_total) },
          { key: 'job_work_cleared', title: 'Settled the charge by', align: 'right', render: (b) => (Number(b.job_work_cleared) ? inr(b.job_work_cleared) : '') },
          { key: 'status', title: '', render: (b) => (b.status === 'cancelled' ? <Badge value="cancelled" /> : null) },
        ]} />
        {can('bills:write') && j.status !== 'cancelled' && (
          <Toggle label="+ Book the job worker's bill">
            {(services.data?.data ?? []).length === 0 ? <p className="muted small">First add a service item for the charge under Masters (for example “Job work charges”, with its SAC code and GST rate).</p> : null}
            {/* The service that looks like a job work charge is offered first. */}
            <Form submit="Book the bill" key={services.data?.data.length ?? 0}
              initial={{ bill_date: istDate(), item_id: ((services.data?.data ?? []).find((x) => /job/i.test(`${x.sku} ${x.name}`)) ?? services.data?.data[0])?.id ?? '' }}
              fields={[
                { name: 'supplier_invoice_no', label: 'Their invoice number', required: true },
                { name: 'bill_date', label: 'Invoice date', type: 'date', required: true },
                { name: 'item_id', label: 'Charged for', type: 'select', required: true, options: (services.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (GST ${Number(s.gst_rate)}%)` })) },
                { name: 'amount', label: 'Amount before GST ₹', type: 'number', required: true },
              ]}
              onSubmit={(v) => post('/purchasing/bills', {
                supplier_id: j.job_worker_id, supplier_invoice_no: v.supplier_invoice_no, bill_date: v.bill_date, job_work_id: id,
                lines: [{ item_id: v.item_id, qty: 1, rate: v.amount, description: `Job work charges, challan ${j.challan_no}` }],
              })}
              onDone={reload} />
            <p className="muted small">The bill is paid like any supplier&apos;s, under Payments, where TDS can be held back.</p>
          </Toggle>
        )}
      </Card>
    </Page>
  );
}
