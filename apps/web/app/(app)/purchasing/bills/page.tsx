'use client';

import { useState } from 'react';
import { Badge, Card, CsvLink, Loading, Page, Table, date, inr } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

export default function BillsPage() {
  const [f, setF] = useState({ q: '', doc_type: '', payment_status: '' });
  const path = `/purchasing/bills${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  const payables = useGet<{ data: any[] }>('/purchasing/payables');
  return (
    <Page title="Purchase bills" actions={<CsvLink href={path} />}>
      <p className="muted">To record a supplier invoice, open its purchase order and choose “Record supplier invoice”.</p>
      {payables.data && payables.data.data.length > 0 && (
        <Card title="Payables per supplier">
          <Table rows={payables.data.data} rowHref={(r) => `/parties/${r.supplier_id}`} columns={[
            { key: 'supplier_name', title: 'Supplier' }, { key: 'open_bills', title: 'Open bills', align: 'right' },
            { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
            { key: 'overdue', title: 'Overdue', align: 'right', render: (r) => inr(r.overdue) },
            { key: 'oldest_due', title: 'Oldest due', render: (r) => date(r.oldest_due) },
          ]} />
        </Card>
      )}
      <div className="filters">
        <input placeholder="Search bill no, supplier invoice, supplier" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>
          <option value="">Bills & debit notes</option><option value="bill">Bills</option><option value="debit_note">Debit notes</option>
        </select>
        <select value={f.payment_status} onChange={(e) => setF({ ...f, payment_status: e.target.value })}>
          <option value="">Any payment status</option><option value="unpaid">Unpaid</option><option value="partly_paid">Partly paid</option><option value="paid">Paid</option>
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/purchasing/bills/${r.id}`} columns={[
        { key: 'bill_no', title: 'Number' },
        { key: 'doc_type', title: 'Type', render: (r) => (r.doc_type === 'debit_note' ? 'Debit note' : 'Bill') },
        { key: 'supplier_invoice_no', title: 'Supplier inv.' },
        { key: 'bill_date', title: 'Date', render: (r) => date(r.bill_date) },
        { key: 'supplier_name', title: 'Supplier' }, { key: 'po_no', title: 'PO' },
        { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) },
        { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => (r.doc_type === 'bill' && r.status === 'posted' ? inr(r.outstanding) : '') },
        { key: 'status', title: 'Status', render: (r) => (r.status === 'cancelled' ? <Badge value="cancelled" /> : r.doc_type === 'bill' ? <Badge value={r.payment_status} /> : <Badge value="posted" />) },
        { key: 'mismatches', title: 'Check', render: (r) => (r.mismatches?.length ? <span className="error small">{r.mismatches.length} mismatch</span> : '') },
      ]} />
    </Page>
  );
}
