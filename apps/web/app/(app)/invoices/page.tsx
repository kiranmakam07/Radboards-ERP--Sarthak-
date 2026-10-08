'use client';

import { useState } from 'react';
import { Badge, CsvLink, Loading, Page, Table, date, inr, label } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

export default function InvoicesPage() {
  const [f, setF] = useState({ q: '', doc_type: '', payment_status: '', channel: '', from: '', to: '' });
  const path = `/sales/invoices${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <Page title="Invoices" actions={<CsvLink href={path} />}>
      <div className="filters">
        <input placeholder="Search number or party" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select value={f.doc_type} onChange={(e) => set('doc_type', e.target.value)}>
          <option value="">Invoices & credit notes</option><option value="tax_invoice">Tax invoices</option><option value="credit_note">Credit notes</option>
        </select>
        <select value={f.payment_status} onChange={(e) => set('payment_status', e.target.value)}>
          <option value="">Any payment status</option><option value="unpaid">Unpaid</option><option value="partly_paid">Partly paid</option><option value="paid">Paid</option>
        </select>
        <select value={f.channel} onChange={(e) => set('channel', e.target.value)}>
          <option value="">All channels</option>{['store', 'dealer', 'shopify', 'amazon', 'flipkart', 'website'].map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
        <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
        <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/invoices/${r.id}`} columns={[
        { key: 'invoice_no', title: 'Number' },
        { key: 'invoice_date', title: 'Date', render: (r) => date(r.invoice_date) },
        { key: 'doc_type', title: 'Type', render: (r) => (r.doc_type === 'credit_note' ? 'Credit note' : 'Invoice') },
        { key: 'party_name', title: 'Party' },
        { key: 'channel', title: 'Channel', render: (r) => label(r.channel) },
        { key: 'taxable_total', title: 'Taxable', align: 'right', render: (r) => inr(r.taxable_total) },
        { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) },
        { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => (r.doc_type === 'tax_invoice' && r.status === 'issued' ? inr(r.outstanding) : '') },
        { key: 'status', title: 'Status', render: (r) => (r.status === 'cancelled' ? <Badge value="cancelled" /> : r.doc_type === 'tax_invoice' ? <Badge value={r.payment_status} /> : <Badge value="issued" />) },
        { key: 'days_overdue', title: 'Overdue', align: 'right', render: (r) => (Number(r.days_overdue) > 0 ? `${r.days_overdue} d` : '') },
      ]} />
    </Page>
  );
}
