'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ORDER_STATUSES } from '@radcore/shared';
import { Badge, CsvLink, Loading, Page, Table, date, inr, label } from '@/components/ui';
import { qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function OrdersPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: '', channel: '' });
  const path = `/sales/orders${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Quotes & orders" actions={
      <>
        <CsvLink href={path} />
        {can('sales:write') && <Link className="button primary" href="/sales/orders/new">+ New quote</Link>}
      </>
    }>
      <div className="filters">
        <input placeholder="Search order no or party" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{ORDER_STATUSES.map((s) => <option key={s} value={s}>{s === 'draft' ? 'Draft (quote)' : label(s)}</option>)}
        </select>
        <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
          <option value="">All channels</option>{['store', 'dealer', 'shopify', 'amazon', 'flipkart', 'website'].map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/sales/orders/${r.id}`} columns={[
        { key: 'order_no', title: 'Order' },
        { key: 'order_date', title: 'Date', render: (r) => date(r.order_date) },
        { key: 'party_name', title: 'Party', render: (r) => r.party_name ?? 'Cash sale' },
        { key: 'channel', title: 'Channel', render: (r) => label(r.channel) },
        { key: 'line_count', title: 'Lines', align: 'right' },
        { key: 'line_amount', title: 'Amount (before tax adj.)', align: 'right', render: (r) => inr(r.line_amount) },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
      ]} />
    </Page>
  );
}
