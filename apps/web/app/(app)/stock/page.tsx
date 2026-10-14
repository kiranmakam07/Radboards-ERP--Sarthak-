'use client';

import { useState } from 'react';
import { ActionButton, Badge, CsvLink, ErrorBox, Loading, Page, Table, Toggle, dateTime, inr, label, num } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';
import { rupees } from '@/components/charts';

const TABS = ['On hand', 'Low stock', 'Movements', 'Adjustments & counts'] as const;

export default function StockPage() {
  const can = useCan();
  const [tab, setTab] = useState<(typeof TABS)[number]>('On hand');
  const [q, setQ] = useState('');
  const locations = useGet<{ data: any[] }>('/masters/locations');
  const items = useGet<{ data: any[] }>('/items?limit=2000');
  const onHand = useGet<{ data: any[] }>(tab === 'On hand' ? `/stock/on-hand${qs({ q, include_zero: 'true', limit: 1000 })}` : null);
  const valuation = useGet<{ total_value: string }>(tab === 'On hand' ? '/stock/valuation' : null);
  const low = useGet<{ data: any[] }>(tab === 'Low stock' ? '/stock/low' : null);
  const moves = useGet<{ data: any[] }>(tab === 'Movements' ? '/stock/movements?limit=200' : null);
  const adjustments = useGet<{ data: any[] }>(tab === 'Adjustments & counts' ? '/stock/adjustments' : null);
  const stockItems = (items.data?.data ?? []).filter((i) => i.is_stock_item);
  const locs = locations.data?.data ?? [];
  const reloadAll = () => { onHand.reload(); adjustments.reload(); moves.reload(); valuation.reload(); };

  return (
    <Page title="Stock" actions={tab === 'On hand' ? <CsvLink href="/stock/on-hand?include_zero=true" /> : tab === 'Movements' ? <CsvLink href="/stock/movements" /> : null}>
      <div className="filters">
        {TABS.map((t) => <button key={t} type="button" className={tab === t ? 'primary' : undefined} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {can('stock:write') && (
        <div className="actions" style={{ alignItems: 'flex-start', marginBottom: 4 }}>
          <Toggle label="Transfer between locations"><MoveForm kind="transfer" items={stockItems} locations={locs} onDone={reloadAll} /></Toggle>
          <Toggle label="Adjust stock"><MoveForm kind="adjustment" items={stockItems} locations={locs} onDone={() => { setTab('Adjustments & counts'); reloadAll(); }} /></Toggle>
          <Toggle label="Physical count"><MoveForm kind="count" items={stockItems} locations={locs} onDone={() => { setTab('Adjustments & counts'); reloadAll(); }} /></Toggle>
          <Toggle label="Opening stock"><MoveForm kind="opening" items={stockItems} locations={locs} onDone={() => { setTab('Adjustments & counts'); reloadAll(); }} /></Toggle>
        </div>
      )}

      {tab === 'On hand' && (
        <>
          <div className="filters">
            <input placeholder="Search item" value={q} onChange={(e) => setQ(e.target.value)} />
            {valuation.data && <span className="muted">Total stock value: <strong>₹{inr(valuation.data.total_value)}</strong></span>}
          </div>
          <Loading loading={onHand.loading} error={onHand.error} />
          <Table rows={onHand.data?.data}
            chart={{ kind: 'bar', name: 'Stock value', label: (r) => r.name, value: (r) => Number(r.value), format: rupees }} columns={[
            { key: 'sku', title: 'SKU' }, { key: 'name', title: 'Item' }, { key: 'item_type', title: 'Type', render: (r) => label(r.item_type) },
            { key: 'stores_qty', title: 'Stores', align: 'right', render: (r) => num(r.stores_qty) },
            { key: 'showroom_qty', title: 'Showroom', align: 'right', render: (r) => num(r.showroom_qty) },
            { key: 'available_qty', title: 'Available', align: 'right', render: (r) => <strong>{num(r.available_qty)}</strong> },
            { key: 'job_work_qty', title: 'With job workers', align: 'right', render: (r) => (Number(r.job_work_qty) ? num(r.job_work_qty) : '') },
            { key: 'rejected_qty', title: 'Rejected', align: 'right', render: (r) => (Number(r.rejected_qty) ? <span className="error small">{num(r.rejected_qty)}</span> : '') },
            { key: 'reorder_level', title: 'Reorder at', align: 'right', render: (r) => num(r.reorder_level) },
            { key: 'avg_cost', title: 'Avg cost', align: 'right', render: (r) => inr(r.avg_cost) },
            { key: 'value', title: 'Value', align: 'right', render: (r) => inr(r.value) },
          ]} />
        </>
      )}

      {tab === 'Low stock' && (
        <>
          <Loading loading={low.loading} error={low.error} />
          <Table rows={low.data?.data} empty="Nothing is below its reorder level." columns={[
            { key: 'sku', title: 'SKU' }, { key: 'name', title: 'Item' }, { key: 'item_type', title: 'Type', render: (r) => label(r.item_type) },
            { key: 'available_qty', title: 'Available', align: 'right', render: (r) => num(r.available_qty) },
            { key: 'reorder_level', title: 'Reorder at', align: 'right', render: (r) => num(r.reorder_level) },
            { key: 'shortfall', title: 'Short by', align: 'right', render: (r) => num(r.shortfall) },
          ]} />
        </>
      )}

      {tab === 'Movements' && (
        <>
          <Loading loading={moves.loading} error={moves.error} />
          <Table rows={moves.data?.data} columns={[
            { key: 'posted_at', title: 'When', render: (r) => dateTime(r.posted_at) },
            { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
            { key: 'location', title: 'Location' },
            { key: 'movement_type', title: 'Type', render: (r) => label(r.movement_type) },
            { key: 'qty', title: 'Qty', align: 'right', render: (r) => <span style={{ color: Number(r.qty) < 0 ? 'var(--danger)' : 'var(--ok)' }}>{Number(r.qty) > 0 ? '+' : ''}{num(r.qty)}</span> },
            { key: 'unit_cost', title: 'Unit cost', align: 'right', render: (r) => inr(r.unit_cost) },
            { key: 'value', title: 'Value', align: 'right', render: (r) => inr(r.value) },
            { key: 'ref_type', title: 'Source', render: (r) => label(r.ref_type) },
            { key: 'reason', title: 'Reason' }, { key: 'user_name', title: 'By' },
          ]} />
        </>
      )}

      {tab === 'Adjustments & counts' && (
        <>
          <p className="muted">Adjustments and counts change stock only after an admin or the owner approves them.</p>
          <Loading loading={adjustments.loading} error={adjustments.error} />
          <Table rows={adjustments.data?.data} empty="No adjustments yet." columns={[
            { key: 'adjustment_no', title: 'Number' }, { key: 'kind', title: 'Kind', render: (r) => label(r.kind) },
            { key: 'location', title: 'Location' }, { key: 'reason', title: 'Reason' },
            { key: 'line_count', title: 'Lines changed', align: 'right' },
            { key: 'created_by_name', title: 'Raised by' }, { key: 'created_at', title: 'Raised', render: (r) => dateTime(r.created_at) },
            { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
            { key: 'decide', title: '', render: (r) => (r.status === 'pending' && can('stock:approve') ? (
              <span className="actions">
                <ActionButton kind="primary" onClick={() => post(`/stock/adjustments/${r.id}/approve`)} onDone={reloadAll}>Approve</ActionButton>
                <ActionButton kind="danger" confirm="Reject this adjustment?" onClick={() => post(`/stock/adjustments/${r.id}/reject`)} onDone={reloadAll}>Reject</ActionButton>
              </span>
            ) : r.decided_by_name) },
          ]} />
        </>
      )}
    </Page>
  );
}

type Row = { item_id: string; qty: string; unit_cost: string };

/** One small form for the four stock actions; they differ only in which numbers they need. */
function MoveForm({ kind, items, locations, onDone }: { kind: 'transfer' | 'adjustment' | 'count' | 'opening'; items: any[]; locations: any[]; onDone: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState(kind === 'opening' ? 'Opening stock' : '');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const qtyLabel = { transfer: 'Qty to move', adjustment: 'Change (+/-)', count: 'Counted qty', opening: 'Qty' }[kind];

  async function save() {
    setError(null);
    try {
      const valid = rows.filter((r) => r.item_id && r.qty !== '');
      if (kind === 'transfer') {
        await post('/stock/transfers', { from_location_id: from, to_location_id: to, reason, lines: valid.map((r) => ({ item_id: r.item_id, qty: r.qty })) });
      } else if (kind === 'count') {
        await post('/stock/counts', { location_id: from, reason, lines: valid.map((r) => ({ item_id: r.item_id, counted_qty: r.qty })) });
      } else {
        await post('/stock/adjustments', {
          kind, location_id: from, reason,
          lines: valid.map((r) => ({ item_id: r.item_id, qty_change: r.qty, unit_cost: r.unit_cost === '' ? null : r.unit_cost })),
        });
      }
      setRows([]); setReason(kind === 'opening' ? 'Opening stock' : '');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ minWidth: 520 }}>
      <div className="form">
        <label><span>{kind === 'transfer' ? 'From' : 'Location'} *</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        {kind === 'transfer' && (
          <label><span>To *</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </label>
        )}
        <label className="wide"><span>Reason *</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
      <div className="filters" style={{ marginTop: 10 }}>
        <select value="" onChange={(e) => e.target.value && !rows.some((r) => r.item_id === e.target.value) && setRows([...rows, { item_id: e.target.value, qty: '', unit_cost: '' }])}>
          <option value="">+ Add item…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name} ({num(i.on_hand)} in stock)</option>)}
        </select>
      </div>
      {rows.length > 0 && (
        <table>
          <thead><tr><th>Item</th><th className="right">{qtyLabel}</th>{(kind === 'opening' || kind === 'adjustment') && <th className="right">Unit cost ₹{kind === 'opening' ? ' *' : ''}</th>}<th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.item_id}>
                <td>{items.find((x) => x.id === r.item_id)?.name}</td>
                <td className="right"><input type="number" step="any" style={{ width: 100 }} value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
                {(kind === 'opening' || kind === 'adjustment') && (
                  <td className="right"><input type="number" step="any" min="0" style={{ width: 110 }} value={r.unit_cost} placeholder={kind === 'adjustment' ? 'current avg' : ''}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)))} /></td>
                )}
                <td><button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={save}>{kind === 'transfer' ? 'Transfer now' : 'Submit for approval'}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

