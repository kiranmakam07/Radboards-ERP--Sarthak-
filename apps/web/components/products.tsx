'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GST_RATES, ITEM_TYPES, UNITS } from '@radcore/shared';
import {
  CsvLink, ErrorBox, FormModal, Loading, Table, UploadField, ViewSwitch, inr, label, num, useRemembered, type Field,
} from '@/components/ui';
import { api, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * The product master: everything Radboards buys, makes and sells, kept once and read by every bill,
 * order, purchase and stock screen. Shown as picture cards or as a list, under Stores → Products and
 * on the Masters page; each product opens on its own page (app/(app)/items/[id]).
 *
 * (In the API and the database a product is an "item": /api/items.)
 */

/** The boxes of a product, in the order a person fills them in. */
export const productFields = (categories: { id: string; name: string }[]): Field[] => [
  { name: 'name', label: 'Product name', required: true },
  { name: 'sku', label: 'Code (SKU)', required: true, help: 'Short and unique, e.g. CRU-27' },
  { name: 'item_type', label: 'Kind', type: 'select', required: true, options: ITEM_TYPES.map((t) => ({ value: t, label: label(t) })) },
  { name: 'category_id', label: 'Category', type: 'select', options: categories.map((c) => ({ value: c.id, label: c.name })) },
  { name: 'unit', label: 'Unit', type: 'select', required: true, options: UNITS.map((u) => ({ value: u, label: u })) },
  { name: 'hsn_sac', label: 'HSN / SAC', help: 'Needed for goods' },
  { name: 'gst_rate', label: 'GST %', type: 'select', required: true, options: GST_RATES.map((r) => ({ value: String(r), label: `${r}%` })) },
  { name: 'retail_price', label: 'Retail price ₹ (with GST)', type: 'number' },
  { name: 'dealer_price', label: 'Dealer price ₹ (before GST)', type: 'number' },
  { name: 'mrp', label: 'MRP ₹', type: 'number' },
  { name: 'purchase_cost', label: 'Purchase cost ₹', type: 'number' },
  { name: 'reorder_level', label: 'Reorder level', type: 'number', help: 'Below this, it shows as low on stock' },
  { name: 'barcode', label: 'Barcode' },
];

/** The first letters of a product's name, shown where it has no picture yet. */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '·';

/** Below its reorder level: shown in red wherever stock is shown. */
export const isLow = (p: any) => p.is_stock_item && p.reorder_level !== null && p.reorder_level !== undefined && Number(p.on_hand) < Number(p.reorder_level);

/** "+ New product": the required boxes in a pop-up, then the new product's own page opens to finish it. */
export function NewProduct({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const categories = useGet<{ data: any[] }>('/masters/item-categories');
  return (
    <FormModal title="New product" submit="Create product" wide onClose={onClose}
      intro={<p className="muted small">Pictures, price lists and stock are added on the product's own page, which opens next.</p>}
      initial={{ item_type: 'finished_good', gst_rate: '18', unit: 'Nos' }}
      fields={productFields(categories.data?.data ?? [])}
      onSubmit={(v) => post<{ data: { id: string } }>('/items', v)}
      onDone={(r) => router.push(`/items/${r.data.id}`)} />
  );
}

/** The products, as picture cards or as a list (remembered per person), with search and filters. */
export function ProductList({ embedded }: { embedded?: boolean }) {
  const can = useCan();
  const [view, setView] = useRemembered('radcore-view:products', ['cards', 'list'] as const, 'cards');
  const [f, setF] = useState({ q: '', type: '', category_id: '', active: 'true' });
  const [adding, setAdding] = useState(false);
  const path = `/items${qs({ ...f, limit: 1000 })}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  const categories = useGet<{ data: any[] }>('/masters/item-categories');
  const rows = data?.data ?? [];

  return (
    <>
      <div className="filters">
        {can('items:write') ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ New product</button> : null}
        <input className="grow" placeholder="Search name, code, barcode" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Kind">
          <option value="">Every kind</option>{ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
        </select>
        <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} aria-label="Category">
          <option value="">Every category</option>{(categories.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })} aria-label="In use">
          <option value="true">In use</option><option value="false">Switched off</option><option value="all">All</option>
        </select>
        <ViewSwitch value={view} onChange={setView}
          options={[{ value: 'cards', label: 'Cards', icon: 'board' }, { value: 'list', label: 'List', icon: 'table' }]} />
        {embedded ? null : <CsvLink href={path} />}
      </div>
      <Loading loading={loading} error={error} />
      {data && rows.length === 0 ? <p className="muted">No products match. {can('items:write') ? 'Add one with + New product.' : ''}</p> : null}
      {data && rows.length > 0 && view === 'cards' ? (
        <div className="product-grid">
          {rows.map((p) => (
            <Link key={p.id} href={`/items/${p.id}`} className={p.active ? 'product-card' : 'product-card off'}>
              <div style={{ minWidth: 0 }}>
                <div className="title">{p.name}</div>
                <div className="meta">{p.sku}{p.category_name ? ` · ${p.category_name}` : ''}</div>
                <div className="price">₹{inr(p.retail_price)} <span className="meta">retail</span></div>
                {p.is_stock_item
                  ? <div className={isLow(p) ? 'stock low' : 'stock'}>{num(p.on_hand)} {p.unit} in stock{isLow(p) ? ' · low' : ''}</div>
                  : <div className="stock muted">{label(p.item_type)}</div>}
              </div>
              {p.image_url ? <img className="product-pic" src={p.image_url} alt="" loading="lazy" /> : <span className="product-pic" aria-hidden="true">{initials(p.name)}</span>}
            </Link>
          ))}
        </div>
      ) : null}
      {data && rows.length > 0 && view === 'list' ? (
        <Table rows={rows} rowHref={(r) => `/items/${r.id}`} columns={[
          { key: 'name', title: 'Product', render: (r) => <>{r.image_url ? <img className="thumb" src={r.image_url} alt="" loading="lazy" /> : null}{r.name}</> },
          { key: 'sku', title: 'Code' },
          { key: 'category_name', title: 'Category' },
          { key: 'item_type', title: 'Kind', render: (r) => label(r.item_type) },
          { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => num(r.gst_rate) },
          { key: 'retail_price', title: 'Retail', align: 'right', render: (r) => inr(r.retail_price) },
          { key: 'dealer_price', title: 'Dealer', align: 'right', render: (r) => inr(r.dealer_price) },
          { key: 'on_hand', title: 'In stock', align: 'right', render: (r) => (r.is_stock_item ? <span className={isLow(r) ? 'error small' : undefined}>{num(r.on_hand)} {r.unit}</span> : '—') },
        ]} />
      ) : null}
      {adding ? <NewProduct onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** A product's pictures: add one from the phone's camera or a file, or take one off. The first is the one shown in lists. */
export function Pictures({ itemId, canChange, onChange }: { itemId: string; canChange: boolean; onChange: () => void }) {
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
    <div>
      <div className="pictures">
        {pictures.map((p) => (
          <figure key={p.id}>
            <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="Picture of the product" loading="lazy" /></a>
            {canChange ? <button type="button" onClick={() => run(() => api(`/items/${itemId}/images/${p.id}`, { method: 'DELETE' }))}>Remove</button> : null}
          </figure>
        ))}
        {pictures.length === 0 ? <p className="muted small">No pictures yet.</p> : null}
      </div>
      {canChange ? (
        <label className="small muted" style={{ display: 'grid', gap: 3, maxWidth: 360 }}>
          Add a picture
          <UploadField purpose="item_image" value="" onChange={(url) => { if (url) void run(() => post(`/items/${itemId}/images`, { url, sort: pictures.length })); }} />
        </label>
      ) : null}
      <ErrorBox error={error} />
    </div>
  );
}
