'use client';

import { useState } from 'react';
import { GST_RATES, LOCATION_TYPES, PARTY_STATE_CODES, STATE_CODES } from '@radcore/shared';
import { ActionButton, Badge, Card, ErrorBox, Form, Loading, Page, Table, Toggle, date, dateTime, inr, label } from '@/components/ui';
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
  const entities = useGet<{ data: any[] }>('/masters/entities');
  const taxRates = useGet<{ data: any[] }>('/masters/tax-rates');
  const s = settings.data?.data;
  if (!s) return <Page title="Setup"><Loading loading={settings.loading} error={settings.error} /></Page>;
  const c = s.company;
  const expenseAccounts = (accounts.data?.data ?? []).filter((a) => a.type === 'expense' && !a.is_group).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));

  return (
    <Page title="Setup">
      {can('audit:read') ? <SystemHealth /> : null}
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

      <Card title="Companies (legal entities)">
        <p className="muted">The company above is the first. Add another only for a separate company with its own GSTIN: its documents carry its name and are numbered on their own, with its letter in front (KINV/26-27/00001).</p>
        <Table rows={entities.data?.data} columns={[
          { key: 'legal_name', title: 'Company', render: (r) => <>{r.legal_name}{r.is_default ? <span className="muted small"> · the company profile</span> : null}</> },
          { key: 'gstin', title: 'GSTIN' }, { key: 'state_code', title: 'State', render: (r) => PARTY_STATE_CODES[r.state_code] ?? r.state_code },
          { key: 'code', title: 'Number letter' },
          { key: 'branches', title: 'Branches', render: (r) => r.branches.map((b: any) => b.name).join(', ') },
        ]} />
        {can('settings:manage') ? (
          <Toggle label="Add a company">
            <Form inline submit="Add company"
              fields={[
                { name: 'legal_name', label: 'Legal name', required: true }, { name: 'gstin', label: 'GSTIN' },
                { name: 'state_code', label: 'State', type: 'select', required: true, options: Object.entries(STATE_CODES).map(([k, n]) => ({ value: k, label: `${k} ${n}` })) },
                { name: 'code', label: 'Number letter', required: true, help: 'One letter, e.g. K' },
              ]}
              onSubmit={(v) => post('/masters/entities', v)} onDone={entities.reload} />
          </Toggle>
        ) : null}
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
        <Card title="Discount limits">
          <p className="muted">The biggest discount off the price list each role may give on its own. More than that, or any price below cost, needs the owner or Accounts to approve it.</p>
          <Form inline submit="Save limits"
            initial={{ store: String(s.discount_limits?.store ?? 0), sales: String(s.discount_limits?.sales ?? 0) }}
            fields={[
              { name: 'store', label: 'Counter (store), %', type: 'number', required: true },
              { name: 'sales', label: 'Sales, %', type: 'number', required: true },
            ]}
            onSubmit={(v) => put('/settings/discount-limits', { discount_limits: { ...s.discount_limits, store: Number(v.store), sales: Number(v.sales) } })}
            onDone={settings.reload} />
        </Card>
        <PoLimits />
        <Card title="Price lists">
          <Table rows={priceLists.data?.data} columns={[
            { key: 'name', title: 'Name' }, { key: 'base_price', title: 'Uses', render: (r) => `${r.base_price} price` },
            { key: 'tax_inclusive', title: 'GST', render: (r) => (r.tax_inclusive ? 'Included' : 'Extra') },
            { key: 'approved_at', title: 'Approved', render: (r) => (r.approved_at ? dateTime(r.approved_at) : <Badge value="pending" />) },
            { key: 'x', title: '', render: (r) => (!r.approved_at && can('pricelists:approve') ? <ActionButton onClick={() => post(`/masters/price-lists/${r.id}/approve`)} onDone={priceLists.reload}>Approve</ActionButton> : null) },
          ]} />
          <p className="muted small">Each item has its own retail and dealer price. A list can give some items a different rate; a party on that list then gets that rate.</p>
          {can('pricelists:write') && priceLists.data && (
            <Toggle label="Set rates on a list"><PriceListRates lists={priceLists.data.data} onDone={priceLists.reload} /></Toggle>
          )}
        </Card>
        <NameList title="Places stock is kept" path="locations"
          extra={{ name: 'type', label: 'Kind', options: LOCATION_TYPES.filter((t) => t !== 'job_work').map((t) => ({ value: t, label: label(t) })) }} />
        <NameList title="Lead sources" path="lead-sources" />
        <NameList title="Lost reasons" path="lost-reasons" />
        <NameList title="Item categories" path="item-categories" />
        <NameList title="Expense categories" path="expense-categories" extra={{ name: 'account_id', label: 'Posts to account', options: expenseAccounts }} />
        <Card title="GST rate changes">
          <p className="muted small">When the government changes the rate for an HSN, enter it here ahead of time: every bill and order dated on or after that day uses it. A longer code wins over a shorter one (871160 over 8711).</p>
          <Table rows={taxRates.data?.data} empty="No changes entered: each product's own GST rate is used." columns={[
            { key: 'hsn', title: 'HSN' }, { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => Number(r.gst_rate) },
            { key: 'cess_rate', title: 'Cess %', align: 'right', render: (r) => (Number(r.cess_rate) ? Number(r.cess_rate) : '') },
            { key: 'effective_from', title: 'From', render: (r) => date(r.effective_from) }, { key: 'note', title: 'Note' },
          ]} />
          {can('masters:manage') ? (
            <Toggle label="Add a rate change">
              <Form inline submit="Add"
                fields={[
                  { name: 'hsn', label: 'HSN', required: true },
                  { name: 'gst_rate', label: 'GST %', type: 'select', required: true, options: GST_RATES.map((r) => ({ value: String(r), label: `${r}%` })) },
                  { name: 'cess_rate', label: 'Cess %', type: 'number' }, { name: 'effective_from', label: 'From', type: 'date', required: true },
                  { name: 'note', label: 'Note' },
                ]}
                onSubmit={(v) => post('/masters/tax-rates', { ...v, cess_rate: v.cess_rate || 0 })} onDone={taxRates.reload} />
            </Toggle>
          ) : null}
        </Card>
        <Card title="Document numbering">
          <Table rows={series.data?.data} empty="Series are created the first time each document is issued." columns={[
            { key: 'doc_type', title: 'Document' }, { key: 'fy', title: 'FY' }, { key: 'prefix', title: 'Prefix' }, { key: 'next_value', title: 'Next no', align: 'right' },
          ]} />
        </Card>
      </div>
    </Page>
  );
}

/**
 * The rate a price list gives each item, where it differs from the item's own price. Leaving a box
 * empty means the item's own price. Saving sends the list back for the founder's approval.
 */
function PriceListRates({ lists, onDone }: { lists: any[]; onDone: () => void }) {
  const [listId, setListId] = useState('');
  const list = lists.find((l) => l.id === listId);
  const items = useGet<{ data: any[] }>(listId ? '/items?limit=2000' : null);
  const rates = useGet<{ data: any[] }>(listId ? `/masters/price-lists/${listId}/items` : null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const current = new Map((rates.data?.data ?? []).map((r) => [r.item_id as string, String(Number(r.rate))]));
  const own = (i: any) => (list?.base_price === 'dealer' ? i.dealer_price : i.retail_price);
  const changed = Object.entries(edits).filter(([itemId, v]) => v !== (current.get(itemId) ?? ''));

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await put(`/masters/price-lists/${listId}/items`, { items: changed.map(([item_id, v]) => ({ item_id, rate: v === '' ? null : v })) });
      setEdits({});
      rates.reload();
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="form inline">
        <label><span>Price list</span>
          <select value={listId} onChange={(e) => { setListId(e.target.value); setEdits({}); }}>
            <option value="">—</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      {list && (
        <>
          <p className="muted small">Rates {list.tax_inclusive ? 'include' : 'are before'} GST, like the item's own {list.base_price} price. Leave a box empty for the item's own price.</p>
          <Loading loading={(items.loading || rates.loading) && !items.data} error={items.error ?? rates.error} />
          <Table rows={(items.data?.data ?? []).filter((i) => i.item_type !== 'raw_material' && i.active !== false)} columns={[
            { key: 'name', title: 'Item', render: (i) => `${i.sku} — ${i.name}` },
            { key: 'own', title: `Its own ${list.base_price} price`, align: 'right', render: (i) => inr(own(i)) },
            { key: 'rate', title: 'Rate on this list', align: 'right', render: (i) => (
              <input type="number" step="0.01" min="0" style={{ width: 110 }} aria-label={`Rate for ${i.name} on ${list.name}`}
                value={edits[i.id] ?? current.get(i.id) ?? ''} placeholder={String(Number(own(i)))}
                onChange={(e) => setEdits((x) => ({ ...x, [i.id]: e.target.value }))} />
            ) },
          ]} />
          <ErrorBox error={problem} />
          <p><button type="button" className="primary" disabled={busy || changed.length === 0} onClick={save}>
            Save {changed.length || ''} {changed.length === 1 ? 'rate' : 'rates'}
          </button></p>
        </>
      )}
    </div>
  );
}

/** Purchase order approval (brief P3): the most each role may send a PO for, with GST; above it the PO waits for the owner. */
function PoLimits() {
  const limits = useGet<{ data: { role: string; max_amount: string }[] }>('/purchasing/approval-limits');
  const of = (role: string) => limits.data?.data.find((l) => l.role === role)?.max_amount ?? '';
  if (!limits.data) return null;
  return (
    <Card title="Purchase order limits">
      <p className="muted">The most each role may send a purchase order for, with GST. Above it, the order waits for the owner to approve it. Blank: no limit.</p>
      <Form inline submit="Save limits"
        initial={{ stores: of('stores') ? String(Number(of('stores'))) : '', accounts: of('accounts') ? String(Number(of('accounts'))) : '' }}
        fields={[
          { name: 'stores', label: 'Stores, ₹', type: 'number' },
          { name: 'accounts', label: 'Accounts, ₹', type: 'number' },
        ]}
        onSubmit={(v) => put('/purchasing/approval-limits', { limits: [{ role: 'stores', max_amount: v.stores || null }, { role: 'accounts', max_amount: v.accounts || null }] })}
        onDone={limits.reload} />
    </Card>
  );
}

/**
 * What went wrong lately, when the background jobs last ran, and whether alerts reach anyone (technical review,
 * 26 Oct 2026: "nothing records errors or warns anyone when something fails").
 */
function SystemHealth() {
  const h = useGet<{ data: any }>('/settings/health');
  const d = h.data?.data;
  if (!d) return null;
  const jobs = Object.entries(d.jobs?.result ?? {}) as [string, string][];
  return (
    <Card title="System health" actions={d.alerts_on ? <ActionButton onClick={() => post('/settings/health/test-alert')}>Send a test alert</ActionButton> : null}>
      <p className="muted small">
        {d.alerts_on ? 'Problems are also sent to the alert channel set on the server.' : 'No alert channel is set on the server (ALERT_WEBHOOK_URL), so problems are only listed here.'}
        {' '}Background jobs {d.jobs?.last_run_at ? <>last ran {dateTime(d.jobs.last_run_at)}</> : 'have not run yet'}
        {d.scheduler === 'cron' ? ' (run by a daily schedule on this host)' : ' (every 15 minutes)'}.
        {jobs.length ? <> {jobs.map(([k, v]) => `${label(k)}: ${v}`).join(' · ')}</> : null}
      </p>
      <Table rows={d.errors} empty="No errors recorded." columns={[
        { key: 'at', title: 'When', render: (e) => dateTime(e.at) },
        { key: 'source', title: 'Where' },
        { key: 'message', title: 'What went wrong', render: (e) => <span style={{ whiteSpace: 'normal' }}>{e.message}</span> },
        { key: 'user_name', title: 'Who was using it' },
      ]} />
    </Card>
  );
}
