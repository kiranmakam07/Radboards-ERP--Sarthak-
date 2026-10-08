'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PO_STATUSES } from '@radcore/shared';
import { Badge, CsvLink, Loading, Page, Table, date, inr, label, num } from '@/components/ui';
import { qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function PurchaseOrdersPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: '' });
  const path = `/purchasing/orders${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Purchase orders" actions={
      <>
        <CsvLink href={path} />
        {can('po:write') && <Link className="button primary" href="/purchasing/orders/new">+ New PO</Link>}
      </>
    }>
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
