'use client';

import { istDate } from '@radcore/shared';
import { ActionButton, Badge, CsvLink, Form, Loading, Page, Table, Toggle, date, inr } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function ExpensesPage() {
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/accounting/expenses');
  const categories = useGet<{ data: any[] }>('/masters/expense-categories');
  const accounts = useGet<{ data: any[] }>('/accounting/money-accounts');
  const rates = useGet<{ data: any[] }>('/tds/rates');
  return (
    <Page title="Expenses" actions={<CsvLink href="/accounting/expenses" />}>
      {can('expenses:write') && (
        <Toggle label="+ Add expense">
          <Form submit="Save expense"
            initial={{ expense_date: istDate(), gst_type: 'none' }}
            fields={[
              { name: 'expense_date', label: 'Date', type: 'date', required: true },
              { name: 'category_id', label: 'Category', type: 'select', required: true, options: (categories.data?.data ?? []).map((c) => ({ value: c.id, label: c.name })) },
              { name: 'amount', label: 'Amount before GST ₹', type: 'number', required: true },
              { name: 'gst_type', label: 'Input GST', type: 'select', required: true, options: [
                { value: 'none', label: 'No GST / not claimable' }, { value: 'intra', label: 'CGST + SGST (same state)' }, { value: 'inter', label: 'IGST (other state)' },
              ] },
              { name: 'gst_amount', label: 'GST amount ₹', type: 'number' },
              { name: 'paid_from_account_id', label: 'Paid from', type: 'select', required: true, options: (accounts.data?.data ?? []).map((a) => ({ value: a.id, label: a.name })) },
              { name: 'vendor_name', label: 'Vendor' },
              { name: 'vendor_gstin', label: 'Vendor GSTIN', help: 'Needed to claim input GST' },
              { name: 'tds_rate_id', label: 'TDS held back for', type: 'select', help: 'Leave blank when no TDS was held back',
                options: (rates.data?.data ?? []).filter((r) => r.active).map((r) => ({ value: r.id, label: `${r.name} (${Number(r.rate)}%)` })) },
              { name: 'tds_amount', label: 'TDS ₹', type: 'number', help: 'Worked out on the amount before GST. The vendor is paid the total less this' },
              { name: 'vendor_pan', label: 'Vendor PAN', help: 'For the TDS return. Not needed when the GSTIN is given' },
              { name: 'attachment_url', label: 'Bill (photo or PDF)', type: 'file', purpose: 'bill' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onSubmit={(v) => post('/accounting/expenses', v)} onDone={reload} />
        </Toggle>
      )}
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No expenses yet." columns={[
        { key: 'expense_no', title: 'Number' }, { key: 'expense_date', title: 'Date', render: (r) => date(r.expense_date) },
        { key: 'category_name', title: 'Category' }, { key: 'vendor_name', title: 'Vendor' }, { key: 'paid_from', title: 'Paid from' },
        { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
        { key: 'gst_amount', title: 'Input GST', align: 'right', render: (r) => (Number(r.gst_amount) ? inr(r.gst_amount) : '') },
        { key: 'total', title: 'Total', align: 'right', render: (r) => inr(r.total) },
        { key: 'tds_amount', title: 'TDS held back', align: 'right', render: (r) => (Number(r.tds_amount) ? <span title={r.tds_rate_name}>{inr(r.tds_amount)}</span> : '') },
        { key: 'attachment_url', title: 'Bill', render: (r) => (r.attachment_url ? <a href={r.attachment_url} target="_blank" rel="noreferrer">View</a> : '') },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'x', title: '', render: (r) => (r.status === 'posted' && can('expenses:write') ? (
          <ActionButton kind="danger" confirm={`Cancel ${r.expense_no}?`} onClick={() => post(`/accounting/expenses/${r.id}/cancel`, { reason: 'Entered in error' })} onDone={reload}>Cancel</ActionButton>
        ) : null) },
      ]} />
    </Page>
  );
}
