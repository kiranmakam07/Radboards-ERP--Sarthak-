'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PO_STATUSES } from '@radcore/shared';
import { Badge, CountCards, CsvLink, Loading, Page, Table, date, inr, label, num } from '@/components/ui';
import { qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

type PoStatus = (typeof PO_STATUSES)[number];

/** Purchase orders, with a card for each stage they wait at: each card is also the filter for it. */
export default function PurchaseOrdersPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: '' });
  const path = `/purchasing/orders${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  const counts = useGet<{ data: Partial<Record<PoStatus, number>> }>('/purchasing/orders/summary').data?.data;
  const n = (s: PoStatus) => (counts ? counts[s] ?? 0 : null);
  return (
    <Page title="Purchase orders" actions={
      <>
        {can('po:write') && <Link className="button primary" href="/purchasing/orders/new">+ New purchase order</Link>}
        <CsvLink href={path} />
      </>
    }>
      <CountCards value={f.status as PoStatus | ''} onChange={(v) => setF({ ...f, status: v })} cards={[
        { key: 'draft', label: 'Drafts to send', count: n('draft') },
        { key: 'sent', label: 'Sent, waiting for goods', count: n('sent'), tone: n('sent') ? 'amber' : undefined },
        { key: 'partly_received', label: 'Partly received', count: n('partly_received'), tone: n('partly_received') ? 'amber' : undefined },
        { key: 'received', label: 'All received', count: n('received'), tone: 'green' },
        { key: 'closed', label: 'Closed', count: n('closed') },
      ]} />
      <div className="filters">
        <input placeholder="Search PO no or supplier" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{PO_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/purchasing/orders/${r.id}`} columns={[
        { key: 'po_no', title: 'PO' },
        { key: 'order_date', title: 'Date', render: (r) => date(r.order_date) },
        { key: 'supplier_name', title: 'Supplier' },
        { key: 'expected_date', title: 'Expected', render: (r) => date(r.expected_date) },
        { key: 'amount', title: 'Amount (excl. GST)', align: 'right', render: (r) => inr(r.amount) },
        { key: 'received_qty', title: 'Received', align: 'right', render: (r) => `${num(r.received_qty)} / ${num(r.ordered_qty)}` },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
      ]} />
    </Page>
  );
}
