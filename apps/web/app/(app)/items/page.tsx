'use client';

import { useState } from 'react';
import { GST_RATES, ITEM_TYPES, UNITS } from '@radcore/shared';
import { Badge, CsvLink, ErrorBox, Form, Loading, Page, Table, Toggle, UploadField, inr, label, num, type Field } from '@/components/ui';
import { api, patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const fields = (categories: any[]): Field[] => [
  { name: 'sku', label: 'SKU', required: true },
  { name: 'name', label: 'Name', required: true },
  { name: 'item_type', label: 'Type', type: 'select', required: true, options: ITEM_TYPES.map((t) => ({ value: t, label: label(t) })) },
  { name: 'category_id', label: 'Category', type: 'select', options: categories.map((c) => ({ value: c.id, label: c.name })) },
  { name: 'hsn_sac', label: 'HSN / SAC', help: 'Required for goods' },
  { name: 'gst_rate', label: 'GST %', type: 'select', required: true, options: GST_RATES.map((r) => ({ value: String(r), label: `${r}%` })) },
  { name: 'unit', label: 'Unit', type: 'select', required: true, options: UNITS.map((u) => ({ value: u, label: u })) },
  { name: 'purchase_cost', label: 'Purchase cost ₹', type: 'number' },
  { name: 'mrp', label: 'MRP ₹', type: 'number' },
  { name: 'retail_price', label: 'Retail price ₹ (incl. GST)', type: 'number' },
  { name: 'dealer_price', label: 'Dealer price ₹ (excl. GST)', type: 'number' },
  { name: 'reorder_level', label: 'Reorder level', type: 'number' },
  { name: 'barcode', label: 'Barcode' },
];

/** The item's pictures: add one from the phone's camera or a file, or take one off. The first is the one shown in lists. */
function Pictures({ itemId, onChange }: { itemId: string; onChange: () => void }) {
  const { data, reload } = useGet<{ data: any[] }>(`/items/${itemId}/images`);
  const [error, setError] = useState<string | null>(null);
  const pictures = data?.data ?? [];
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      reload();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div style={{ marginTop: 14 }}>
      <h3>Pictures</h3>
      <div className="pictures">
        {pictures.map((p) => (
          <figure key={p.id}>
            <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="Picture of the item" loading="lazy" /></a>
            <button type="button" onClick={() => run(() => api(`/items/${itemId}/images/${p.id}`, { method: 'DELETE' }))}>Remove</button>
          </figure>
        ))}
        {pictures.length === 0 ? <p className="muted small">No pictures yet.</p> : null}
      </div>
      <label className="small muted" style={{ display: 'grid', gap: 3, maxWidth: 360 }}>
        Add a picture
        <UploadField purpose="item_image" value="" onChange={(url) => { if (url) void run(() => post(`/items/${itemId}/images`, { url, sort: pictures.length })); }} />
      </label>
      <ErrorBox error={error} />
    </div>
  );
}

export default function ItemsPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', type: '', active: 'true' });
  const [editing, setEditing] = useState<any | null>(null);
  const path = `/items${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const categories = useGet<{ data: any[] }>('/masters/item-categories');
  const write = can('items:write');

  return (
    <Page title="Items" actions={<CsvLink href={path} />}>
      {write && !editing && (
        <Toggle label="+ Add item">
          <Form fields={fields(categories.data?.data ?? [])} initial={{ item_type: 'finished_good', gst_rate: '18', unit: 'Nos' }}
            onSubmit={(v) => post('/items', v)} onDone={reload} />
        </Toggle>
      )}
      {editing && (
        <div className="toggle-body" style={{ marginBottom: 12 }}>
          <div className="card-head"><h2>Edit {editing.sku}</h2><button type="button" onClick={() => setEditing(null)}>× Close</button></div>
          <Form key={editing.id} fields={[...fields(categories.data?.data ?? []), { name: 'active', label: 'Active', type: 'checkbox' }]}
            initial={{
              ...editing, gst_rate: String(Number(editing.gst_rate)), category_id: editing.category_id ?? '', hsn_sac: editing.hsn_sac ?? '',
              reorder_level: editing.reorder_level ?? '', barcode: editing.barcode ?? '',
            }}
            onSubmit={(v) => patch(`/items/${editing.id}`, Object.fromEntries(fields([]).map((x) => [x.name, v[x.name]]).concat([['active', v.active]])))}
            onDone={() => { setEditing(null); reload(); }} />
          <Pictures itemId={editing.id} onChange={reload} />
        </div>
      )}
      <div className="filters">
        <input placeholder="Search name, SKU, barcode" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All types</option>{ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
        </select>
        <select value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })}>
          <option value="true">Active</option><option value="false">Inactive</option><option value="all">All</option>
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} columns={[
        { key: 'sku', title: 'SKU' },
        { key: 'name', title: 'Name', render: (r) => <>{r.image_url ? <img className="thumb" src={r.image_url} alt="" loading="lazy" /> : null}{r.name}</> },
        { key: 'item_type', title: 'Type', render: (r) => label(r.item_type) },
        { key: 'hsn_sac', title: 'HSN' },
        { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => num(r.gst_rate) },
        { key: 'purchase_cost', title: 'Cost', align: 'right', render: (r) => inr(r.purchase_cost) },
        { key: 'retail_price', title: 'Retail', align: 'right', render: (r) => inr(r.retail_price) },
        { key: 'dealer_price', title: 'Dealer', align: 'right', render: (r) => inr(r.dealer_price) },
        { key: 'on_hand', title: 'In stock', align: 'right', render: (r) => (r.is_stock_item ? <span className={r.reorder_level !== null && Number(r.on_hand) < Number(r.reorder_level) ? 'error small' : undefined}>{num(r.on_hand)} {r.unit}</span> : '—') },
        { key: 'active', title: '', render: (r) => (r.active ? null : <Badge value="closed" />) },
        { key: 'edit', title: '', render: (r) => (write ? <button type="button" onClick={() => setEditing(r)}>Edit</button> : null) },
      ]} />
    </Page>
  );
}
