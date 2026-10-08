'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES } from '@radcore/shared';
import { partyBody, partyFields } from '@/components/party-form';
import { Badge, Card, CsvLink, Form, KV, Loading, Page, Table, Toggle, date, inr, label } from '@/components/ui';
import { patch, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function PartyPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/parties/${id}`);
  const priceLists = useGet<{ data: any[] }>('/masters/price-lists');
  const ledger = useGet<{ data: any[]; closing_balance: string }>(can('accounts:read') ? `/parties/${id}/ledger` : null);
  const p = data?.data;
  if (!p) return <Page title="Party"><Loading loading={loading} error={error} /></Page>;
  const bal = Number(p.balance);
  const a = p.billing_address ?? {};

  return (
    <Page title={p.name} actions={
      <>
        {p.party_type !== 'supplier' && can('quickbill:create') && <Link className="button" href={`/quick-bill?party_id=${p.id}`}>Quick bill</Link>}
        {p.party_type !== 'supplier' && can('sales:write') && <Link className="button" href={`/sales/orders/new?party_id=${p.id}`}>New quote / order</Link>}
        {can('payments:write') && <Link className="button" href={`/payments?party_id=${p.id}`}>Record payment</Link>}
      </>
    }>
      <Card>
        <KV rows={[
          ['Type', <Badge value={p.party_type} />], ['Phone', p.phone], ['Email', p.email], ['GSTIN', p.gstin],
          ['State', `${STATE_CODES[p.state_code] ?? ''} (${p.state_code})`],
          ['Address', [a.line1, a.city, a.pincode].filter(Boolean).join(', ')],
          ['Credit limit', p.credit_limit ? `₹${inr(p.credit_limit)}` : null],
          ['Payment terms', p.payment_terms_days !== null ? `${p.payment_terms_days} days` : null],
          ['Balance', bal === 0 ? 'Nil' : `₹${inr(Math.abs(bal))} ${bal > 0 ? '(they owe us)' : '(we owe them / advance)'}`],
          ['From lead', p.lead_id ? <Link href={`/leads/${p.lead_id}`}>View lead</Link> : null],
        ]} />
      </Card>

      {can('parties:write') && (
        <Toggle label="Edit party">
          <Form fields={partyFields(priceLists.data?.data ?? [], false)}
            initial={{
              name: p.name, phone: p.phone ?? '', email: p.email ?? '', gstin: p.gstin ?? '', state_code: p.gstin ? '' : p.state_code,
              line1: a.line1 ?? '', city: a.city ?? '', pincode: a.pincode ?? '', price_list_id: p.price_list_id ?? '',
              credit_limit: p.credit_limit ?? '', payment_terms_days: p.payment_terms_days ?? '',
            }}
            onSubmit={(v) => patch(`/parties/${id}`, partyBody(v))} onDone={reload} />
        </Toggle>
      )}

      {p.open_invoices.length > 0 && (
        <Card title="Unpaid invoices">
          <Table rows={p.open_invoices} rowHref={(r) => `/invoices/${r.invoice_id}`} columns={[
            { key: 'invoice_no', title: 'Invoice' }, { key: 'invoice_date', title: 'Date', render: (r) => date(r.invoice_date) },
            { key: 'due_date', title: 'Due', render: (r) => date(r.due_date) },
            { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) },
            { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
            { key: 'payment_status', title: 'Status', render: (r) => <Badge value={r.payment_status} /> },
          ]} />
        </Card>
      )}
      {p.open_bills.length > 0 && (
        <Card title="Unpaid bills">
          <Table rows={p.open_bills} rowHref={(r) => `/purchasing/bills/${r.bill_id}`} columns={[
            { key: 'bill_no', title: 'Bill' }, { key: 'supplier_invoice_no', title: 'Supplier inv.' },
            { key: 'bill_date', title: 'Date', render: (r) => date(r.bill_date) }, { key: 'due_date', title: 'Due', render: (r) => date(r.due_date) },
            { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) },
            { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
          ]} />
        </Card>
      )}

      {ledger.data && (
        <Card title="Ledger" actions={<CsvLink href={`/parties/${id}/ledger`} />}>
          <Table rows={ledger.data.data} empty="No transactions yet." columns={[
            { key: 'entry_date', title: 'Date', render: (r) => date(r.entry_date) },
            { key: 'narration', title: 'Particulars', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.narration}</span> },
            { key: 'ref_type', title: 'Type', render: (r) => label(r.ref_type) },
            { key: 'debit', title: 'Debit', align: 'right', render: (r) => (Number(r.debit) ? inr(r.debit) : '') },
            { key: 'credit', title: 'Credit', align: 'right', render: (r) => (Number(r.credit) ? inr(r.credit) : '') },
            { key: 'balance', title: 'Balance', align: 'right', render: (r) => `${inr(Math.abs(Number(r.balance)))} ${Number(r.balance) >= 0 ? 'Dr' : 'Cr'}` },
          ]} />
        </Card>
      )}
    </Page>
  );
}
