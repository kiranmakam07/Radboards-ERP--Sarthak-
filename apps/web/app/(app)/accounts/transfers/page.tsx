'use client';

import { istDate } from '@radcore/shared';
import { ActionButton, Form, Loading, Page, Table, Toggle, date, inr } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * Money moved between our own accounts: counter cash put in the bank, cash drawn out, one bank
 * account to another. Nothing is earned or spent, so it touches neither sales nor expenses.
 */
export default function TransfersPage() {
  const can = useCan();
  const write = can('accounts:write');
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/accounting/transfers');
  const money = useGet<{ data: any[] }>('/accounting/money-accounts');
  const options = (money.data?.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));
  const cash = (money.data?.data ?? []).find((a) => a.subtype === 'cash')?.id ?? '';
  const bank = (money.data?.data ?? []).find((a) => a.subtype === 'bank')?.id ?? '';

  return (
    <Page title="Cash & bank transfers">
      <p className="muted">Cash deposited in the bank, cash withdrawn, or a transfer between two bank accounts.</p>
      {write && money.data && (
        <Toggle label="+ Move money">
          <Form submit="Record the transfer" initial={{ from_account_id: cash, to_account_id: bank, date: istDate() }}
            fields={[
              { name: 'from_account_id', label: 'From', type: 'select', required: true, options },
              { name: 'to_account_id', label: 'To', type: 'select', required: true, options },
              { name: 'amount', label: 'Amount ₹', type: 'number', step: '0.01', required: true },
              { name: 'date', label: 'Date', type: 'date', required: true },
              { name: 'reference', label: 'Reference', placeholder: 'Deposit slip or UTR number' },
              { name: 'notes', label: 'Notes' },
            ]}
            onSubmit={(v) => post('/accounting/transfers', v)}
            onDone={reload} />
        </Toggle>
      )}
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No transfers yet." columns={[
        { key: 'entry_date', title: 'Date', render: (r) => date(r.entry_date) },
        { key: 'from_account', title: 'From' },
        { key: 'to_account', title: 'To' },
        { key: 'amount', title: 'Amount', align: 'right', render: (r) => `₹${inr(r.amount)}` },
        { key: 'narration', title: 'Details', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.narration}</span> },
        { key: 'x', title: '', render: (r) => (r.reversed ? <span className="badge grey">Reversed</span> : write ? (
          <ActionButton confirm="Reverse this transfer? An opposite entry is made; nothing is deleted."
            onClick={() => post(`/accounting/journals/${r.id}/reverse`, { reason: 'Transfer entered by mistake' })} onDone={reload}>Reverse</ActionButton>
        ) : null) },
      ]} />
    </Page>
  );
}
