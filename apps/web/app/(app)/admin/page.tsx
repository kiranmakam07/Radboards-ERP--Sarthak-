'use client';

import { STATE_CODES } from '@radcore/shared';
import { ActionButton, Badge, Card, Form, Loading, Page, Table, date, dateTime } from '@/components/ui';
import { patch, post, put, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Admin-managed list with a name and an on/off switch. */
function NameList({ title, path, extra }: { title: string; path: string; extra?: { name: string; label: string; options: { value: string; label: string }[] } }) {
  const { data, reload } = useGet<{ data: any[] }>(`/masters/${path}`);
  return (
    <Card title={title}>
      <Table rows={data?.data} columns={[
        { key: 'name', title: 'Name' },
        ...(extra ? [{ key: extra.name, title: extra.label, render: (r: any) => extra.options.find((o) => o.value === r[extra.name])?.label ?? r.account_name ?? '' }] : []),
        { key: 'active', title: '', render: (r) => (r.active === false ? <Badge value="closed" /> : null) },
        { key: 'x', title: '', render: (r) => (r.active !== undefined && path !== 'expense-categories' ? (
          <ActionButton onClick={() => patch(`/masters/${path}/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton>
        ) : null) },
      ]} />
      <div style={{ marginTop: 10 }}>
        <Form inline submit="Add"
          fields={[{ name: 'name', label: 'New', required: true }, ...(extra ? [{ name: extra.name, label: extra.label, type: 'select' as const, required: true, options: extra.options }] : [])]}
          onSubmit={(v) => post(`/masters/${path}`, v)} onDone={reload} />
      </div>
    </Card>
  );
}

export default function AdminPage() {
  const can = useCan();
  const settings = useGet<{ data: any }>('/settings');
  const priceLists = useGet<{ data: any[] }>('/masters/price-lists');
  const accounts = useGet<{ data: any[] }>('/accounting/accounts');
  const series = useGet<{ data: any[] }>('/settings/number-series');
  const s = settings.data?.data;
  if (!s) return <Page title="Setup"><Loading loading={settings.loading} error={settings.error} /></Page>;
  const c = s.company;
  const expenseAccounts = (accounts.data?.data ?? []).filter((a) => a.type === 'expense' && !a.is_group).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));

  return (
    <Page title="Setup">
      <Card title="Company profile (printed on invoices)">
        <Form submit="Save company"
          initial={{
            name: c.name ?? '', gstin: c.gstin ?? '', state_code: c.state_code ?? '', phone: c.phone ?? '', email: c.email ?? '',
            line1: c.address?.line1 ?? '', city: c.address?.city ?? '', state: c.address?.state ?? '', pincode: c.address?.pincode ?? '',
            bank_name: c.bank?.bank_name ?? '', account_no: c.bank?.account_no ?? '', ifsc: c.bank?.ifsc ?? '', upi_id: c.bank?.upi_id ?? '',
            invoice_terms: c.invoice_terms ?? '',
          }}
          fields={[
            { name: 'name', label: 'Company name', required: true },
            { name: 'gstin', label: 'GSTIN', help: 'Checked for format and checksum' },
            { name: 'state_code', label: 'State', type: 'select', required: true, options: Object.entries(STATE_CODES).map(([k, n]) => ({ value: k, label: `${k} ${n}` })) },
            { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' },
            { name: 'line1', label: 'Address' }, { name: 'city', label: 'City' }, { name: 'state', label: 'State name' }, { name: 'pincode', label: 'Pincode' },
            { name: 'bank_name', label: 'Bank' }, { name: 'account_no', label: 'Account no' }, { name: 'ifsc', label: 'IFSC' }, { name: 'upi_id', label: 'UPI ID' },
            { name: 'invoice_terms', label: 'Terms printed on invoices', type: 'textarea' },
          ]}
          onSubmit={(v) => put('/settings/company', {
            name: v.name, gstin: v.gstin, state_code: v.state_code, phone: v.phone, email: v.email,
            address: { line1: v.line1, city: v.city, state: v.state, pincode: v.pincode },
            bank: { bank_name: v.bank_name, account_no: v.account_no, ifsc: v.ifsc, upi_id: v.upi_id, account_name: v.name },
            invoice_terms: v.invoice_terms,
          })}
          onDone={settings.reload} />
      </Card>

      <div className="grid">
        <Card title="Period lock">
          <p className="muted">Nothing dated on or before this date can be posted or changed. Set it after filing a month.</p>
          <p>Currently: <strong>{s.period_lock_date ? date(s.period_lock_date) : 'not locked'}</strong></p>
          <Form inline submit="Set lock date" initial={{ period_lock_date: s.period_lock_date ?? '' }}
            fields={[{ name: 'period_lock_date', label: 'Lock up to', type: 'date' }]}
            onSubmit={(v) => put('/settings/period-lock', { period_lock_date: v.period_lock_date || null })} onDone={settings.reload} />
        </Card>
        <Card title="Stock rules">
          <p className="muted">By default a sale is refused when there is not enough stock. Allowing negative stock lets billing continue while inwards are still being entered.</p>
          <p>Negative stock: <strong>{s.allow_negative_stock ? 'allowed' : 'blocked'}</strong> · Valuation: <strong>moving average</strong></p>
          {can('settings:manage') && (
            <ActionButton confirm={s.allow_negative_stock ? undefined : 'Allow stock to go negative?'}
              onClick={() => put('/settings/stock', { allow_negative_stock: !s.allow_negative_stock })} onDone={settings.reload}>
              {s.allow_negative_stock ? 'Block negative stock' : 'Allow negative stock'}
            </ActionButton>
          )}
        </Card>
        <Card title="Price lists">
          <Table rows={priceLists.data?.data} columns={[
            { key: 'name', title: 'Name' }, { key: 'base_price', title: 'Uses', render: (r) => `${r.base_price} price` },
            { key: 'tax_inclusive', title: 'GST', render: (r) => (r.tax_inclusive ? 'Included' : 'Extra') },
            { key: 'approved_at', title: 'Approved', render: (r) => (r.approved_at ? dateTime(r.approved_at) : <Badge value="pending" />) },
            { key: 'x', title: '', render: (r) => (!r.approved_at && can('pricelists:approve') ? <ActionButton onClick={() => post(`/masters/price-lists/${r.id}/approve`)} onDone={priceLists.reload}>Approve</ActionButton> : null) },
          ]} />
          <p className="muted small">Item prices are set on each item (retail and dealer price).</p>
        </Card>
        <NameList title="Lead sources" path="lead-sources" />
        <NameList title="Lost reasons" path="lost-reasons" />
        <NameList title="Item categories" path="item-categories" />
        <NameList title="Expense categories" path="expense-categories" extra={{ name: 'account_id', label: 'Posts to account', options: expenseAccounts }} />
        <Card title="Document numbering">
          <Table rows={series.data?.data} empty="Series are created the first time each document is issued." columns={[
            { key: 'doc_type', title: 'Document' }, { key: 'fy', title: 'FY' }, { key: 'prefix', title: 'Prefix' }, { key: 'next_value', title: 'Next no', align: 'right' },
          ]} />
        </Card>
      </div>
    </Page>
  );
}
