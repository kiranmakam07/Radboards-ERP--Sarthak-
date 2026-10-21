'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Pictures, initials, productFields } from '@/components/products';
import {
  ActionButton, Card, FormModal, KV, Loading, Page, SmartButton, StatusBar, Table, Tabs, dateTime, inr, label, num,
} from '@/components/ui';
import { patch, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

type Tab = 'overview' | 'prices' | 'stock' | 'pictures';

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '');

/**
 * One product, with everything about it on one page: what it is and what it costs (Overview and
 * Prices), where it is and how it moved (Stock), and its pictures. Along the top, what is happening
 * with it: in stock, sold in the last 90 days, waiting to go out to customers and to come in from
 * suppliers. Changes are made in a pop-up (Edit), so the page itself stays easy to read.
 */
export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const write = can('items:write');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/items/${id}`);
  const categories = useGet<{ data: any[] }>('/masters/item-categories');
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const p = data?.data;
  if (!p) return <Page title="Product"><Loading loading={loading} error={error} /></Page>;

  const cats = categories.data?.data ?? [];
  const category = cats.find((c) => c.id === p.category_id)?.name;
  const sellable = (p.stock as any[]).filter((s) => s.type === 'stores' || s.type === 'showroom').reduce((t, s) => t + Number(s.qty), 0);
  const low = p.is_stock_item && p.reorder_level !== null && sellable < Number(p.reorder_level);
  const a = p.activity ?? {};
  const dealerBeforeGst = Number(p.dealer_price);
  const retailBeforeGst = Number(p.retail_price) / (1 + Number(p.gst_rate) / 100);
  const cost = Number(p.purchase_cost);

  return (
    <Page title={p.name}
      smart={
        <>
          {p.is_stock_item ? (
            <SmartButton icon="stores" value={`${num(sellable)} ${p.unit}`} label={low ? 'In stock · low' : 'In stock'} tone={low ? 'red' : undefined} onClick={() => setTab('stock')} />
          ) : null}
          <SmartButton icon="trend" value={`${num(a.sold_qty ?? 0)} ${p.unit}`} label={`Sold, 90 days · ₹${inr(a.sold_value ?? 0).replace(/\.00$/, '')}`} />
          {p.is_stock_item ? <SmartButton icon="sales" value={num(a.to_deliver ?? 0)} label="To deliver" tone={Number(a.to_deliver) > sellable ? 'amber' : undefined} href="/sales/orders" /> : null}
          {p.is_stock_item ? <SmartButton icon="store" value={num(a.to_receive ?? 0)} label="Coming in" href="/purchasing/orders" /> : null}
        </>
      }
      status={<StatusBar steps={['In use']} current={0} stopped={p.active ? null : 'Switched off'} />}
      actions={write ? (
        <>
          <button type="button" className="primary" onClick={() => setEditing(true)}>Edit</button>
          <ActionButton onClick={() => patch(`/items/${id}`, { active: !p.active })} onDone={reload}
            confirm={p.active ? 'Switch this product off? It stays on old bills but cannot be picked for new ones.' : undefined}>
            {p.active ? 'Switch off' : 'Switch back on'}
          </ActionButton>
        </>
      ) : null}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, { key: 'prices', label: 'Prices' },
        ...(p.is_stock_item ? [{ key: 'stock' as Tab, label: 'Stock' }] : []), { key: 'pictures', label: 'Pictures' },
      ]} />

      {/* Keyed by the tab, so the new tab's content fades in. */}
      <div key={tab} className="tab-panel">

      {tab === 'overview' ? (
        <div className="grid">
          <Card title="What it is">
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {p.images?.[0] ? <img className="product-pic" style={{ width: 110, height: 110 }} src={p.images[0].url} alt="" />
                : <span className="product-pic" style={{ width: 110, height: 110, fontSize: 28 }} aria-hidden="true">{initials(p.name)}</span>}
              <KV rows={[
                ['Code (SKU)', p.sku], ['Kind', label(p.item_type)], ['Category', category],
                ['Unit', p.unit], ['HSN / SAC', p.hsn_sac], ['GST', `${num(p.gst_rate)}%`], ['Barcode', p.barcode],
              ]} />
            </div>
          </Card>
          <Card title="Prices at a glance">
            <KV rows={[
              ['Retail (with GST)', `₹${inr(p.retail_price)}`], ['Dealer (before GST)', `₹${inr(p.dealer_price)}`],
              ['MRP', `₹${inr(p.mrp)}`], ['Purchase cost', `₹${inr(p.purchase_cost)}`],
              ['Margin, retail', cost ? `${pct(retailBeforeGst - cost, retailBeforeGst)} (₹${inr((retailBeforeGst - cost).toFixed(2))})` : ''],
              ['Margin, dealer', cost ? `${pct(dealerBeforeGst - cost, dealerBeforeGst)} (₹${inr((dealerBeforeGst - cost).toFixed(2))})` : ''],
            ]} />
          </Card>
        </div>
      ) : null}

      {tab === 'prices' ? (
        <>
          <Card title="Its own prices">
            <KV rows={[
              ['Retail (with GST)', `₹${inr(p.retail_price)}`], ['Before GST', `₹${inr(retailBeforeGst.toFixed(2))}`],
              ['Dealer (before GST)', `₹${inr(p.dealer_price)}`], ['MRP', `₹${inr(p.mrp)}`], ['Purchase cost', `₹${inr(p.purchase_cost)}`],
            ]} />
          </Card>
          <Card title="On price lists" actions={can('settings:manage') ? <Link href="/admin">Price lists</Link> : null}>
            <Table rows={p.price_list_rates} empty="No price list has its own rate for it: every list uses the prices above." columns={[
              { key: 'name', title: 'Price list' },
              { key: 'rate', title: 'Rate', align: 'right', render: (r) => inr(r.rate) },
            ]} />
          </Card>
        </>
      ) : null}

      {tab === 'stock' ? (
        <>
          <div className="grid">
            <Card title="Where it is">
              <Table rows={(p.stock as any[]).filter((s) => Number(s.qty) !== 0 || s.type !== 'job_work')} columns={[
                { key: 'location', title: 'Place' },
                { key: 'type', title: 'Kind', render: (r) => label(r.type) },
                { key: 'qty', title: 'Quantity', align: 'right', render: (r) => `${num(r.qty)} ${p.unit}` },
              ]} />
            </Card>
            <Card title="Its value">
              <KV rows={[
                ['Reorder level', p.reorder_level !== null ? `${num(p.reorder_level)} ${p.unit}` : 'Not set'],
                ['On hand, all places', `${num(p.valuation.qty)} ${p.unit}`],
                ['Value at cost', `₹${inr(p.valuation.value)}`],
                ['Average cost', p.valuation.avg_cost ? `₹${inr(p.valuation.avg_cost)}` : ''],
              ]} />
            </Card>
          </div>
          <Card title="Last movements" actions={<Link href="/stock">Stock</Link>}>
            <Table rows={p.movements} empty="It has not moved yet." columns={[
              { key: 'posted_at', title: 'When', render: (r) => dateTime(r.posted_at) },
              { key: 'movement_type', title: 'What', render: (r) => label(r.movement_type) },
              { key: 'location', title: 'Where' },
              { key: 'qty', title: 'Quantity', align: 'right', render: (r) => <span className={Number(r.qty) < 0 ? 'muted' : undefined}>{Number(r.qty) > 0 ? '+' : ''}{num(r.qty)}</span> },
              { key: 'reason', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.reason}</span> },
            ]} />
          </Card>
        </>
      ) : null}

      {tab === 'pictures' ? <Card title="Pictures"><Pictures itemId={id} canChange={write} onChange={reload} /></Card> : null}
      </div>

      {editing ? (
        <FormModal title={`Edit ${p.name}`} submit="Save" wide onClose={() => setEditing(false)}
          initial={{
            ...p, gst_rate: String(Number(p.gst_rate)), category_id: p.category_id ?? '', hsn_sac: p.hsn_sac ?? '',
            reorder_level: p.reorder_level ?? '', barcode: p.barcode ?? '',
          }}
          fields={productFields(cats)}
          onSubmit={(v) => patch(`/items/${id}`, Object.fromEntries(productFields([]).map((x) => [x.name, v[x.name]])))}
          onDone={reload} />
      ) : null}
    </Page>
  );
}
