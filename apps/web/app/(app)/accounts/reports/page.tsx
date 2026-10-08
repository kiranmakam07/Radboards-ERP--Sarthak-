'use client';

import { istDate } from '@radcore/shared';
import { useState } from 'react';
import { Card, CsvLink, Form, Loading, Page, Table, date, inr, label } from '@/components/ui';
import { put, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const TABS = ['Trial balance', 'Profit & loss', 'Balance sheet', 'Receivables', 'Payables', 'Ledger / cash & bank book', 'Health check'] as const;
type Tab = (typeof TABS)[number];
const today = () => istDate();

/** Every report here is a query over the journal - not a separate set of books (PRD 7.8). */
export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('Trial balance');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState('');
  const accounts = useGet<{ data: any[] }>('/accounting/accounts');
  const leaf = (accounts.data?.data ?? []).filter((a) => !a.is_group);

  const paths: Record<Tab, string | null> = {
    'Trial balance': `/accounting/reports/trial-balance${qs({ as_of: to })}`,
    'Profit & loss': `/accounting/reports/profit-and-loss${qs({ from, to })}`,
    'Balance sheet': `/accounting/reports/balance-sheet${qs({ as_of: to })}`,
    Receivables: '/accounting/reports/receivables-ageing',
    Payables: '/accounting/reports/payables-ageing',
    'Ledger / cash & bank book': accountId ? `/accounting/reports/ledger${qs({ account_id: accountId, from, to })}` : null,
    'Health check': '/accounting/reports/integrity',
  };
  const { data, loading, error } = useGet<any>(paths[tab]);
  const amountList = (rows: any[]) => (
    <Table rows={rows} empty="Nothing to show." columns={[
      { key: 'code', title: 'Code' }, { key: 'name', title: 'Account' }, { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
    ]} />
  );
  const ageing = (
    <Table rows={data?.data} empty="Nothing outstanding." rowHref={(r) => (r.party_id && r.party_id !== 'cash' ? `/parties/${r.party_id}` : null)} columns={[
      { key: 'party_name', title: 'Party' }, { key: 'phone', title: 'Phone' },
      { key: 'not_due', title: 'Not due', align: 'right', render: (r) => inr(r.not_due) },
      { key: 'd0_30', title: '1–30 days', align: 'right', render: (r) => inr(r.d0_30) },
      { key: 'd31_60', title: '31–60', align: 'right', render: (r) => inr(r.d31_60) },
      { key: 'd61_90', title: '61–90', align: 'right', render: (r) => inr(r.d61_90) },
      { key: 'd90_plus', title: '90+', align: 'right', render: (r) => inr(r.d90_plus) },
      { key: 'total', title: 'Total', align: 'right', render: (r) => <strong>{inr(r.total)}</strong> },
    ]} />
  );

  return (
    <Page title="Books & reports" actions={paths[tab] && tab !== 'Health check' ? <CsvLink href={paths[tab]!} /> : null}>
      <div className="filters">
        {TABS.map((t) => <button key={t} type="button" className={tab === t ? 'primary' : undefined} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="filters">
        {(tab === 'Profit & loss' || tab === 'Ledger / cash & bank book') && <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
        {!['Receivables', 'Payables', 'Health check'].includes(tab) && <label>{tab === 'Profit & loss' || tab.startsWith('Ledger') ? 'To' : 'As of'} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
        {tab === 'Ledger / cash & bank book' && (
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Pick an account…</option>
            {leaf.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}{a.subtype ? ` (${a.subtype})` : ''}</option>)}
          </select>
        )}
      </div>
      <Loading loading={loading} error={error} />

      {tab === 'Trial balance' && data && (
        <>
          <Table rows={data.data} empty="No entries yet." columns={[
            { key: 'code', title: 'Code' }, { key: 'name', title: 'Account' }, { key: 'type', title: 'Type', render: (r) => label(r.type) },
            { key: 'debit', title: 'Debit', align: 'right', render: (r) => (Number(r.debit) ? inr(r.debit) : '') },
            { key: 'credit', title: 'Credit', align: 'right', render: (r) => (Number(r.credit) ? inr(r.credit) : '') },
          ]} footer={<tr><td colSpan={3}>Total {data.balanced ? '(balanced)' : '— NOT BALANCED'}</td><td className="right">{inr(data.total_debit)}</td><td className="right">{inr(data.total_credit)}</td></tr>} />
        </>
      )}

      {tab === 'Profit & loss' && data?.income && (
        <div className="grid">
          <Card title={`Income — ₹${inr(data.total_income)}`}>{amountList(data.income)}</Card>
          <Card title={`Expenses — ₹${inr(data.total_expense)}`}>{amountList(data.expense)}</Card>
          <Card title="Result"><div className="stat-value">{Number(data.net_profit) >= 0 ? 'Net profit' : 'Net loss'} ₹{inr(Math.abs(Number(data.net_profit)))}</div><p className="muted">{date(data.from)} to {date(data.to)}</p></Card>
        </div>
      )}

      {tab === 'Balance sheet' && data?.assets && (
        <div className="grid">
          <Card title={`Assets — ₹${inr(data.total_assets)}`}>{amountList(data.assets)}</Card>
          <Card title={`Liabilities — ₹${inr(data.total_liabilities)}`}>{amountList(data.liabilities)}</Card>
          <Card title={`Equity — ₹${inr(data.total_equity)}`}>{amountList(data.equity)}<p className={data.balanced ? 'muted' : 'error'}>{data.balanced ? 'Assets = Liabilities + Equity' : 'Balance sheet does not balance'}</p></Card>
        </div>
      )}

      {(tab === 'Receivables' || tab === 'Payables') && ageing}

      {tab === 'Ledger / cash & bank book' && data?.account && (
        <>
          <p className="muted">Opening balance ₹{inr(data.opening_balance)} · Closing balance ₹{inr(data.closing_balance)}</p>
          <Table rows={data.data} empty="No entries in this period." columns={[
            { key: 'entry_date', title: 'Date', render: (r) => date(r.entry_date) },
            { key: 'narration', title: 'Particulars', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.narration}</span> },
            { key: 'party_name', title: 'Party' }, { key: 'ref_type', title: 'Type', render: (r) => label(r.ref_type) },
            { key: 'debit', title: 'Debit', align: 'right', render: (r) => (Number(r.debit) ? inr(r.debit) : '') },
            { key: 'credit', title: 'Credit', align: 'right', render: (r) => (Number(r.credit) ? inr(r.credit) : '') },
            { key: 'balance', title: 'Balance', align: 'right', render: (r) => inr(r.balance) },
          ]} />
        </>
      )}

      {tab === 'Health check' && <PeriodLock />}
      {tab === 'Health check' && data?.data && (
        <Card title="Are the books consistent?">
          <Table rows={[
            { check: 'Total debits equal total credits', ok: data.data.journal_balanced, detail: `Dr ${inr(data.data.total_debit)} / Cr ${inr(data.data.total_credit)}` },
            { check: 'No unbalanced journal entries', ok: data.data.unbalanced_entries === 0, detail: `${data.data.unbalanced_entries} found` },
            { check: 'Stock in Hand ledger equals stock valuation', ok: data.data.stock_matches_gl, detail: `Ledger ${inr(data.data.stock_gl)} / Stock ${inr(data.data.stock_ledger_value)}` },
          ]} columns={[
            { key: 'check', title: 'Check' }, { key: 'ok', title: 'Result', render: (r) => <span className={r.ok ? undefined : 'error'}>{r.ok ? 'OK' : 'PROBLEM'}</span> }, { key: 'detail', title: 'Detail' },
          ]} />
        </Card>
      )}
    </Page>
  );
}

/** Month close: once a month is filed, lock it so nothing in it can be posted or changed (PRD 7.8). */
function PeriodLock() {
  const can = useCan();
  const settings = useGet<{ data: any }>('/settings');
  const lock = settings.data?.data.period_lock_date;
  return (
    <Card title="Period lock">
      <p>Books are locked up to: <strong>{lock ? date(lock) : 'not locked'}</strong></p>
      {can('accounts:write') && (
        <Form inline submit="Set lock date" initial={{ period_lock_date: lock ?? '' }} key={lock ?? 'none'}
          fields={[{ name: 'period_lock_date', label: 'Lock up to (blank to unlock)', type: 'date' }]}
          onSubmit={(v) => put('/settings/period-lock', { period_lock_date: v.period_lock_date || null })} onDone={settings.reload} />
      )}
    </Card>
  );
}
