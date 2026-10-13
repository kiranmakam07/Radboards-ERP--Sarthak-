'use client';

import { useState } from 'react';
import { EMPLOYMENT_TYPES, GST_RATES, ITEM_TYPES, STATE_CODES, UNITS } from '@radcore/shared';
import { partyBody, partyFields } from '@/components/party-form';
import { Badge, CsvLink, ErrorBox, Form, Loading, Table, Toggle, UploadField, date, inr, label, num, type Field } from '@/components/ui';
import { api, patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * The masters: the set-up records every other screen reads from. Each list here is the same one
 * shown under Stores, Sales and HR; what differs is who may change it.
 */

const itemFields = (categories: any[]): Field[] => [
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

export function ItemsMaster({ onChange }: { onChange?: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ q: '', type: '', active: 'true' });
  const [editing, setEditing] = useState<any | null>(null);
  const path = `/items${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const categories = useGet<{ data: any[] }>('/masters/item-categories');
  const write = can('items:write');
  const changed = () => { reload(); onChange?.(); };

  return (
    <>
      {write && !editing && (
        <Toggle label="+ Add item">
          <Form fields={itemFields(categories.data?.data ?? [])} initial={{ item_type: 'finished_good', gst_rate: '18', unit: 'Nos' }}
            onSubmit={(v) => post('/items', v)} onDone={changed} />
        </Toggle>
      )}
      {editing && (
        <div className="toggle-body" style={{ marginBottom: 12 }}>
          <div className="card-head"><h2>Edit {editing.sku}</h2><button type="button" onClick={() => setEditing(null)}>× Close</button></div>
          <Form key={editing.id} fields={[...itemFields(categories.data?.data ?? []), { name: 'active', label: 'Active', type: 'checkbox' }]}
            initial={{
              ...editing, gst_rate: String(Number(editing.gst_rate)), category_id: editing.category_id ?? '', hsn_sac: editing.hsn_sac ?? '',
              reorder_level: editing.reorder_level ?? '', barcode: editing.barcode ?? '',
            }}
            onSubmit={(v) => patch(`/items/${editing.id}`, Object.fromEntries(itemFields([]).map((x) => [x.name, v[x.name]]).concat([['active', v.active]])))}
            onDone={() => { setEditing(null); changed(); }} />
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
        <CsvLink href={path} />
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
    </>
  );
}

/**
 * Customers and dealers, or suppliers, or all of them. Someone who sells or buys can add a new
 * one while working; the price list, credit limit and payment terms are for whoever keeps the master.
 */
export function PartiesMaster({ side, onChange }: { side?: 'customers' | 'suppliers'; onChange?: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ q: '', type: '', active: 'true' });
  const path = `/parties${qs({ ...f, side: side ?? '' })}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const priceLists = useGet<{ data: any[] }>('/masters/price-lists');
  const manage = can('parties:manage');
  const types = side === 'suppliers' ? ['supplier'] : side === 'customers' ? ['customer', 'dealer'] : ['customer', 'dealer', 'supplier'];
  const fields = partyFields(priceLists.data?.data ?? [], true, manage)
    .map((x) => (x.name === 'party_type' ? { ...x, options: (x.options ?? []).filter((o) => types.includes(String(o.value))) } : x));
  const noun = side === 'suppliers' ? 'supplier' : side === 'customers' ? 'customer' : 'party';

  return (
    <>
      {(manage || can('parties:write')) && (
        <Toggle label={`+ Add ${noun}`}>
          {!manage ? <p className="muted small">A price list, credit limit and payment terms are set afterwards by whoever keeps the masters.</p> : null}
          <Form fields={fields} initial={{ party_type: types[0] }}
            onSubmit={(v) => post('/parties', partyBody(v))} onDone={() => { reload(); onChange?.(); }} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, phone, GSTIN" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        {types.length > 1 && ['', ...types].map((t) => (
          <button key={t} type="button" className={f.type === t ? 'primary' : undefined} onClick={() => setF({ ...f, type: t })}>{t ? `${t[0]!.toUpperCase()}${t.slice(1)}s` : 'All'}</button>
        ))}
        <select value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })}>
          <option value="true">Active</option><option value="false">Switched off</option><option value="all">All</option>
        </select>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/parties/${r.id}`} columns={[
        { key: 'name', title: 'Name' },
        { key: 'party_type', title: 'Type', render: (r) => <Badge value={r.party_type} /> },
        { key: 'phone', title: 'Phone' },
        { key: 'gstin', title: 'GSTIN' },
        { key: 'state_code', title: 'State', render: (r) => STATE_CODES[r.state_code] ?? r.state_code },
        { key: 'price_list_name', title: 'Price list' },
        { key: 'credit_limit', title: 'Credit limit', align: 'right', render: (r) => inr(r.credit_limit) },
        { key: 'payment_terms_days', title: 'Terms', align: 'right', render: (r) => (r.payment_terms_days === null ? '' : `${r.payment_terms_days} days`) },
        // Positive = they owe us; negative = we owe them / they have an advance.
        { key: 'balance', title: 'Balance', align: 'right', render: (r) => (Number(r.balance) === 0 ? '' : `${inr(Math.abs(Number(r.balance)))} ${Number(r.balance) > 0 ? 'Dr' : 'Cr'}`) },
        { key: 'active', title: '', render: (r) => (r.active ? null : <Badge value="closed" />) },
      ]} />
    </>
  );
}

export const employeeFields = (users: any[]): Field[] => [
  { name: 'name', label: 'Name', required: true },
  { name: 'phone', label: 'Phone', type: 'tel', required: true },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'department', label: 'Department', required: true },
  { name: 'designation', label: 'Designation', required: true },
  { name: 'employment_type', label: 'Type', type: 'select', required: true, options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: label(t) })) },
  { name: 'join_date', label: 'Joining date', type: 'date', required: true },
  { name: 'monthly_salary', label: 'Salary (per month)', type: 'number' },
  { name: 'user_id', label: 'Their sign-in', type: 'select', help: 'If they use RadCore', options: users.map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
];

export function EmployeesMaster({ onChange }: { onChange?: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: 'active' });
  const path = `/hr/employees${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const users = useGet<{ data: any[] }>('/masters/users-lite');

  return (
    <>
      {can('employees:manage') && (
        <Toggle label="+ Add employee">
          <p className="muted small">For people already working here. A new joiner is added by pressing Hire on their application.</p>
          <Form submit="Save employee" initial={{ employment_type: 'full_time' }} fields={employeeFields(users.data?.data ?? [])}
            onSubmit={(v) => post('/hr/employees', v)} onDone={() => { reload(); onChange?.(); }} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, number, phone" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="active">On the rolls</option><option value="left">Left</option><option value="">Everyone</option>
        </select>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No employees match." rowHref={(r) => `/hr/employees/${r.id}`} columns={[
        { key: 'employee_no', title: 'No.' },
        { key: 'name', title: 'Name' },
        { key: 'department', title: 'Department' },
        { key: 'designation', title: 'Designation' },
        { key: 'phone', title: 'Phone' },
        { key: 'employment_type', title: 'Type', render: (r) => label(r.employment_type) },
        { key: 'join_date', title: 'Joined', render: (r) => date(r.join_date) },
        { key: 'monthly_salary', title: 'Salary', align: 'right', render: (r) => inr(r.monthly_salary) },
        { key: 'user_name', title: 'Sign-in', render: (r) => (r.user_name ? `${r.user_name} (${r.user_role})` : '') },
        { key: 'status', title: 'Status', render: (r) => <><Badge value={r.status} />{r.left_on ? <span className="muted small"> {date(r.left_on)}</span> : null}</> },
      ]} />
    </>
  );
}
