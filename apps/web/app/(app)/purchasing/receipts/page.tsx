'use client';

import { useState } from 'react';
import { Badge, Loading, Page, Table, dateTime, num } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

const VIEWS: [string, string, Record<string, string>][] = [
  ['all', 'All', {}], ['qc', 'Waiting for QC', { status: 'received' }], ['returns', 'Rejects awaiting return', { pending_return: 'true' }],
];

export default function ReceiptsPage() {
  const [view, setView] = useState('all');
  const { data, loading, error } = useGet<{ data: any[] }>(`/purchasing/receipts${qs(VIEWS.find((v) => v[0] === view)![2])}`);
  return (
    <Page title="Inward & QC">
      <p className="muted">To inward goods, open the purchase order and choose “Receive goods”. Goods enter stock only after QC.</p>
      <div className="filters">
        {VIEWS.map(([k, l]) => <button key={k} type="button" className={view === k ? 'primary' : undefined} onClick={() => setView(k)}>{l}</button>)}
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="Nothing here." rowHref={(r) => `/purchasing/receipts/${r.id}`} columns={[
        { key: 'grn_no', title: 'GRN' }, { key: 'received_at', title: 'Received', render: (r) => dateTime(r.received_at) },
        { key: 'supplier_name', title: 'Supplier' }, { key: 'po_no', title: 'PO' },
        { key: 'received_qty', title: 'Received', align: 'right', render: (r) => num(r.received_qty) },
        { key: 'accepted_qty', title: 'Accepted', align: 'right', render: (r) => (r.status === 'inwarded' ? num(r.accepted_qty) : '') },
        { key: 'rejected_qty', title: 'Rejected', align: 'right', render: (r) => (r.status === 'inwarded' ? num(r.rejected_qty) : '') },
        { key: 'pending_return_qty', title: 'To return', align: 'right', render: (r) => (Number(r.pending_return_qty) ? <span className="error small">{num(r.pending_return_qty)}</span> : '') },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
      ]} />
    </Page>
  );
}
