'use client';

import { ACCOUNT_TYPES } from '@radcore/shared';
import { Badge, CsvLink, Form, Loading, Page, Table, Toggle, inr } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const KIND: Record<string, string> = { asset: 'Asset', liability: 'Liability', equity: "Owner's funds", income: 'Income', expense: 'Expense' };

/**
 * The chart of accounts: every account the books use and what each holds today. Accounts can add
 * one here (a second bank account, a new kind of expense) and rename or switch off one. The
 * accounts the system posts to by itself (Debtors, Stock in Hand, GST and so on) can be renamed but
 * not switched off.
 */
export default function ChartOfAccountsPage() {
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/accounting/accounts');
  const rows = data?.data ?? [];
  const groups = rows.filter((a) => a.is_group);

  return (
    <Page title="Chart of accounts" actions={<CsvLink href="/accounting/accounts" />}>
      <p className="muted">
        A new bank account added here as a money account can be used straight away on payments, expenses, transfers and bank reconciliation.
      </p>
      {can('accounts:write') && (
        <>
          <Toggle label="+ Add an account">
            <Form submit="Add the account" fields={[
              { name: 'code', label: 'Code', required: true, placeholder: 'e.g. 1120',
                help: 'Not used by another account. By custom: 1xxx assets, 2xxx liabilities, 3xxx owner’s funds, 4xxx income, 5xxx expenses.' },
              { name: 'name', label: 'Name', required: true, placeholder: 'e.g. HDFC Bank current account' },
              { name: 'type', label: 'Kind', type: 'select', required: true, options: ACCOUNT_TYPES.map((t) => ({ value: t, label: KIND[t] ?? t })) },
              { name: 'subtype', label: 'Money account', type: 'select', options: [{ value: 'bank', label: 'A bank account' }, { value: 'cash', label: 'Cash' }],
                help: 'Only for an asset. Leave blank for anything that is not cash or a bank.' },
              { name: 'parent_id', label: 'Shown under', type: 'select', options: groups.map((g) => ({ value: g.id, label: `${g.code} ${g.name}` })) },
              { name: 'is_group', label: 'This is a heading that holds other accounts', type: 'checkbox' },
            ]} onSubmit={(v) => post('/accounting/accounts', { ...v, is_group: Boolean(v.is_group) })} onDone={reload} />
          </Toggle>
          <Toggle label="Rename or switch off an account">
            <Form submit="Save" fields={[
              { name: 'id', label: 'Account', type: 'select', required: true, options: rows.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })) },
              { name: 'name', label: 'New name', help: 'Leave blank to keep the name.' },
              { name: 'state', label: 'In use', type: 'select', options: [{ value: 'on', label: 'In use' }, { value: 'off', label: 'Switched off' }],
                help: 'A switched-off account stays in past reports; nothing new can be posted to it. Leave blank for no change.' },
            ]} onSubmit={(v) => patch(`/accounting/accounts/${v.id}`, {
              ...(v.name ? { name: v.name } : {}), ...(v.state ? { active: v.state === 'on' } : {}),
            })} onDone={reload} />
          </Toggle>
        </>
      )}
      <Loading loading={loading && !data} error={error} />
      <Table rows={data?.data} columns={[
        { key: 'code', title: 'Code' },
        { key: 'name', title: 'Account', render: (a) => (a.is_group ? <strong>{a.name}</strong> : <span style={{ paddingLeft: a.parent_id ? 14 : 0 }}>{a.name}</span>) },
        { key: 'type', title: 'Kind', render: (a) => KIND[a.type] ?? a.type },
        { key: 'subtype', title: 'Money account', render: (a) => (a.subtype ? <Badge value={a.subtype} /> : '') },
        { key: 'active', title: '', render: (a) => (a.active ? '' : <Badge value="switched_off" />) },
        { key: 'balance', title: 'Balance', align: 'right', render: (a) => (a.is_group || a.balance === undefined || Number(a.balance) === 0 ? ''
          : `${inr(Math.abs(Number(a.balance)))} ${Number(a.balance) > 0 ? 'Dr' : 'Cr'}`) },
      ]} />
    </Page>
  );
}
