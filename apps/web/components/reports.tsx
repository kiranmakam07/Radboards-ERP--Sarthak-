'use client';

import Link from 'next/link';
import { useState } from 'react';
import { istDate, monthName, tdsQuarter } from '@radcore/shared';
import { ActionButton, Badge, Card, CsvLink, Form, Loading, Stat, Table, Toggle, date, inr, label, num } from '@/components/ui';
import { patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';


// Where a line in the day book leads: the document behind the entry.
const DOCUMENT: Record<string, (id: string) => string> = {
  invoice: (id) => `/invoices/${id}`, invoice_cancel: (id) => `/invoices/${id}`, credit_note: (id) => `/invoices/${id}`, credit_note_cancel: (id) => `/invoices/${id}`,
  payment: (id) => `/payments/${id}`, purchase_bill: (id) => `/purchasing/bills/${id}`, goods_receipt: (id) => `/purchasing/receipts/${id}`,
  payroll: (id) => `/hr/payroll/${id}`, payroll_payment: (id) => `/hr/payroll/${id}`,
};
// The words used on the other screens for each kind of entry.
const KIND: Record<string, string> = {
  invoice: 'Sale', invoice_cancel: 'Sale cancelled', credit_note: 'Sales return', credit_note_cancel: 'Return cancelled', payment: 'Payment',
  purchase_bill: 'Purchase bill', purchase_return: 'Purchase return', goods_receipt: 'Goods received', delivery: 'Goods delivered',
  expense: 'Expense', manual: 'Journal', transfer: 'Cash / bank transfer', stock_adjustment: 'Stock adjustment', stock_transfer: 'Stock transfer',
  payroll: 'Salaries', payroll_payment: 'Salaries paid', salary_advance: 'Salary advance', tds_deposit: 'TDS deposit', year_close: 'Year-end close',
  job_work_receipt: 'Job work',
};
const kind = (t: string) => KIND[t] ?? label(t);

/** Day book: everything entered on a day, with the cash and bank money it moved. */
export function DayBook() {
  const [from, setFrom] = useState(istDate());
  const [to, setTo] = useState(istDate());
  const [type, setType] = useState('');
  const path = `/accounting/reports/day-book${qs({ from, to, type })}`;
  const { data, loading, error } = useGet<any>(path);
  const oneDay = from === to;
  return (
    <>
      <div className="filters">
        <label>From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" onClick={() => { setFrom(istDate()); setTo(istDate()); }}>Today</button>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Kind of transaction">
          <option value="">All transactions</option>
          {Object.keys(KIND).map((t) => <option key={t} value={t}>{KIND[t]}</option>)}
        </select>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading && !data} error={error} />
      {data?.totals && (
        <>
          <div className="stats">
            <Stat label="Transactions" value={data.totals.entries} hint={oneDay ? date(from) : `${date(from)} to ${date(to)}`} />
            <Stat label="Money in" value={`₹${inr(data.totals.money_in)}`} hint="cash and bank" />
            <Stat label="Money out" value={`₹${inr(data.totals.money_out)}`} hint="cash and bank" />
            <Stat label={Number(data.totals.net) >= 0 ? 'More came in than went out' : 'More went out than came in'} value={`₹${inr(Math.abs(Number(data.totals.net)))}`} />
          </div>
          <Table rows={data.data} empty="Nothing was entered in these dates." rowHref={(r) => (r.ref_id && DOCUMENT[r.type] ? DOCUMENT[r.type]!(r.ref_id) : null)} columns={[
            ...(oneDay ? [] : [{ key: 'entry_date', title: 'Date', render: (r: any) => date(r.entry_date) }]),
            { key: 'entry_no', title: 'Entry' },
            { key: 'type', title: 'What', render: (r) => <>{kind(r.type)}{r.reversal ? <span className="muted small"> · reversal</span> : null}</> },
            { key: 'party_name', title: 'Party' },
            { key: 'narration', title: 'Particulars', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.narration}</span> },
            { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            { key: 'money_in', title: 'Money in', align: 'right', render: (r) => (Number(r.money_in) ? inr(r.money_in) : '') },
            { key: 'money_out', title: 'Money out', align: 'right', render: (r) => (Number(r.money_out) ? inr(r.money_out) : '') },
          ]} footer={data.data.length ? <tr><td colSpan={oneDay ? 5 : 6}>Total</td><td className="right">{inr(data.totals.money_in)}</td><td className="right">{inr(data.totals.money_out)}</td></tr> : undefined} />
          {data.by_type.length > 1 && (
            <Card title="By kind of transaction">
              <Table rows={data.by_type} columns={[
                { key: 'type', title: 'What', render: (r) => kind(r.type) }, { key: 'entries', title: 'Entries', align: 'right' },
                { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
                { key: 'money_in', title: 'Money in', align: 'right', render: (r) => (Number(r.money_in) ? inr(r.money_in) : '') },
                { key: 'money_out', title: 'Money out', align: 'right', render: (r) => (Number(r.money_out) ? inr(r.money_out) : '') },
              ]} />
            </Card>
          )}
        </>
      )}
    </>
  );
}

/** Profit by customer: what each bought, what it cost us, and what was made on it. */
export function PartyProfit() {
  const [from, setFrom] = useState(`${istDate().slice(0, 7)}-01`);
  const [to, setTo] = useState(istDate());
  const path = `/accounting/reports/party-profit${qs({ from, to })}`;
  const { data, loading, error } = useGet<any>(path);
  return (
    <>
      <div className="filters">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading && !data} error={error} />
      {data?.totals && (
        <>
          <div className="stats">
            <Stat label="Sold, before GST" value={`₹${inr(data.totals.sale)}`} />
            <Stat label="What it cost us" value={`₹${inr(data.totals.cost)}`} />
            <Stat label="Profit on goods" value={`₹${inr(data.totals.profit)}`} hint={`${date(data.from)} to ${date(data.to)} · before expenses`} />
          </div>
          <Table rows={data.data} empty="No bills in these dates." rowHref={(r) => (r.party_id ? `/parties/${r.party_id}` : null)} columns={[
            { key: 'party_name', title: 'Customer', render: (r) => <>{r.party_name}{r.party_type === 'dealer' ? <span className="muted small"> · dealer</span> : null}</> },
            { key: 'bills', title: 'Bills', align: 'right', render: (r) => <>{r.bills}{r.returns ? <span className="muted small"> · {r.returns} returned</span> : null}</> },
            { key: 'sale', title: 'Sold for', align: 'right', render: (r) => inr(r.sale) },
            { key: 'cost', title: 'Cost', align: 'right', render: (r) => inr(r.cost) },
            { key: 'profit', title: 'Profit', align: 'right', render: (r) => <strong className={Number(r.profit) < 0 ? 'error small' : undefined}>{inr(r.profit)}</strong> },
            { key: 'margin_pct', title: 'Margin', align: 'right', render: (r) => (r.margin_pct === null ? '' : `${num(r.margin_pct)}%`) },
          ]} />
        </>
      )}
    </>
  );
}

/** Sales by HSN: quantity, value and tax under each HSN or SAC code, net of returns. */
export function HsnSummary() {
  const [from, setFrom] = useState(`${istDate().slice(0, 7)}-01`);
  const [to, setTo] = useState(istDate());
  const path = `/gst/gstr1${qs({ section: 'hsn', from, to })}`;
  const { data, loading, error } = useGet<{ data: any[] }>(from && to ? path : null);
  const rows = data?.data ?? [];
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  return (
    <>
      <div className="filters">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading && !data} error={error} />
      <Table rows={data?.data} empty="Nothing was billed in these dates." columns={[
        { key: 'hsn', title: 'HSN / SAC' }, { key: 'uqc', title: 'Unit' },
        { key: 'rate', title: 'GST %', align: 'right', render: (r) => num(r.rate) },
        { key: 'total_qty', title: 'Quantity', align: 'right', render: (r) => num(r.total_qty) },
        { key: 'taxable_value', title: 'Value before GST', align: 'right', render: (r) => inr(r.taxable_value) },
        { key: 'igst', title: 'IGST', align: 'right', render: (r) => (Number(r.igst) ? inr(r.igst) : '') },
        { key: 'cgst', title: 'CGST', align: 'right', render: (r) => (Number(r.cgst) ? inr(r.cgst) : '') },
        { key: 'sgst', title: 'SGST', align: 'right', render: (r) => (Number(r.sgst) ? inr(r.sgst) : '') },
        { key: 'total_value', title: 'Total', align: 'right', render: (r) => <strong>{inr(r.total_value)}</strong> },
      ]} footer={rows.length ? (
        <tr><td colSpan={4}>Total</td><td className="right">{inr(sum('taxable_value'))}</td><td className="right">{inr(sum('igst'))}</td>
          <td className="right">{inr(sum('cgst'))}</td><td className="right">{inr(sum('sgst'))}</td><td className="right">{inr(sum('total_value'))}</td></tr>
      ) : undefined} />
      <p className="muted small">The same figures go into the HSN table of GSTR-1 on the <Link href="/gst">GST</Link> screen.</p>
    </>
  );
}

/**
 * TDS, both ways round: what we held back from vendors and still have to pay over, and what
 * customers held back from us (tax already paid on our behalf).
 */
export function Tds() {
  const can = useCan();
  const write = can('accounts:write');
  const q = tdsQuarter(istDate());
  const [from, setFrom] = useState(q.from);
  const [to, setTo] = useState(q.to > istDate() ? istDate() : q.to);
  const payable = useGet<any>(`/tds/payable${qs({ from, to })}`);
  const receivable = useGet<any>(`/tds/receivable${qs({ from, to })}`);
  const deposits = useGet<{ data: any[] }>('/tds/deposits');
  const rates = useGet<{ data: any[] }>('/tds/rates');
  const money = useGet<{ data: any[] }>(write ? '/accounting/money-accounts' : null);
  const p = payable.data;
  const r = receivable.data;
  const reload = () => { payable.reload(); deposits.reload(); };
  const quarter = (n: number) => {
    // The four quarters of this financial year, for the return.
    const first = `${q.fy.slice(0, 4)}-04-01`;
    const start = new Date(`${first}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() + (n - 1) * 3);
    const picked = tdsQuarter(start.toISOString().slice(0, 10));
    setFrom(picked.from); setTo(picked.to);
  };

  return (
    <>
      <div className="filters">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {[1, 2, 3, 4].map((n) => <button key={n} type="button" onClick={() => quarter(n)}>Q{n} {q.fy}</button>)}
      </div>
      <p className="muted small">
        TDS is entered where the money is: on a payment to a supplier, on an expense, or on a customer&apos;s receipt. This screen adds it up for the
        quarterly return and records paying it over.
      </p>

      <Card title="TDS we held back" actions={<CsvLink href={`/tds/payable${qs({ from, to })}`} />}>
        <Loading loading={payable.loading && !p} error={payable.error} />
        {p?.totals && (
          <>
            <div className="stats">
              <Stat label="Held back in these dates" value={`₹${inr(p.totals.tds)}`} hint={`on ₹${inr(p.totals.base)}`} />
              <Stat label="Paid over for these months" value={`₹${inr(p.totals.deposited)}`} />
              <Stat label="Owed to the government now" value={`₹${inr(p.owed_now.vendor)}`} hint="from vendors, all dates" />
              {Number(p.owed_now.salary) ? <Stat label="Owed from salaries" value={`₹${inr(p.owed_now.salary)}`} hint="held back in payroll" /> : null}
            </div>
            <Table rows={p.by_month} empty="No TDS was held back in these dates." columns={[
              { key: 'month', title: 'Month', render: (m) => monthName(m.month) },
              { key: 'deducted', title: 'Held back', align: 'right', render: (m) => inr(m.deducted) },
              { key: 'deposited', title: 'Paid over', align: 'right', render: (m) => inr(m.deposited) },
              { key: 'left', title: 'Still to pay', align: 'right', render: (m) => (Number(m.left) > 0 ? <strong className={m.overdue ? 'error small' : undefined}>{inr(m.left)}</strong> : '') },
              { key: 'due_on', title: 'Due by', render: (m) => <>{date(m.due_on)}{m.overdue ? <span className="error small"> · overdue</span> : null}</> },
            ]} />
            {p.by_kind.length > 0 && (
              <Table rows={p.by_kind} columns={[
                { key: 'kind', title: 'Kind of payment' }, { key: 'law_reference', title: 'In the law' }, { key: 'return_code', title: 'Code on the return' },
                { key: 'rate', title: 'Rate', align: 'right', render: (k) => (k.rate === null ? '' : `${num(k.rate)}%`) },
                { key: 'entries', title: 'Payments', align: 'right' },
                { key: 'base', title: 'Paid or credited', align: 'right', render: (k) => inr(k.base) },
                { key: 'tds', title: 'TDS', align: 'right', render: (k) => <strong>{inr(k.tds)}</strong> },
              ]} />
            )}
            <Table rows={p.data} empty="" rowHref={(d) => (d.source === 'payment' ? `/payments/${d.id}` : null)} columns={[
              { key: 'date', title: 'Date', render: (d) => date(d.date) }, { key: 'doc_no', title: 'Number' },
              { key: 'deductee', title: 'Held back from' }, { key: 'pan', title: 'PAN', render: (d) => d.pan ?? <span className="error small">missing</span> },
              { key: 'kind', title: 'Kind of payment' },
              { key: 'base', title: 'On', align: 'right', render: (d) => inr(d.base) },
              { key: 'tds', title: 'TDS', align: 'right', render: (d) => inr(d.tds) },
            ]} />
          </>
        )}
      </Card>

      <Card title="Paid over to the government" actions={<CsvLink href="/tds/deposits" />}>
        {write && money.data && (
          <Toggle label="+ Record a deposit">
            <Form submit="Record the deposit"
              initial={{ kind: 'vendor', paid_on: istDate(), month: istDate().slice(0, 7), account_id: money.data.data.find((a) => a.subtype === 'bank')?.id ?? '' }}
              fields={[
                { name: 'kind', label: 'Held back from', type: 'select', required: true, options: [{ value: 'vendor', label: 'Vendors (payments and expenses)' }, { value: 'salary', label: 'Salaries (payroll)' }] },
                { name: 'month', label: 'For the month (YYYY-MM)', required: true, placeholder: '2026-10' },
                { name: 'amount', label: 'Amount ₹', type: 'number', step: '0.01', required: true },
                { name: 'paid_on', label: 'Paid on', type: 'date', required: true },
                { name: 'account_id', label: 'Paid from', type: 'select', required: true, options: money.data.data.map((a) => ({ value: a.id, label: a.name })) },
                { name: 'challan_no', label: 'Challan number' }, { name: 'bsr_code', label: 'Bank branch (BSR) code' },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ]}
              onSubmit={(v) => post('/tds/deposits', v)} onDone={reload} />
          </Toggle>
        )}
        <Table rows={deposits.data?.data} empty="Nothing has been paid over yet." columns={[
          { key: 'paid_on', title: 'Paid on', render: (d) => date(d.paid_on) },
          { key: 'month', title: 'For', render: (d) => monthName(d.month) },
          { key: 'kind', title: 'From', render: (d) => (d.kind === 'salary' ? 'Salaries' : 'Vendors') },
          { key: 'amount', title: 'Amount', align: 'right', render: (d) => inr(d.amount) },
          { key: 'account_name', title: 'Paid from' }, { key: 'challan_no', title: 'Challan' }, { key: 'bsr_code', title: 'BSR code' },
          { key: 'status', title: '', render: (d) => (d.status === 'cancelled' ? <Badge value="cancelled" /> : null) },
          { key: 'x', title: '', render: (d) => (write && d.status === 'posted' ? (
            <ActionButton confirm="Cancel this deposit? Its entry will be reversed and the TDS shows as owed again."
              onClick={() => post(`/tds/deposits/${d.id}/cancel`, { reason: 'Entered in error' })} onDone={reload}>Cancel</ActionButton>
          ) : null) },
        ]} />
      </Card>

      <Card title="TDS customers held back from us" actions={<CsvLink href={`/tds/receivable${qs({ from, to })}`} />}>
        <Loading loading={receivable.loading && !r} error={receivable.error} />
        {r?.totals && (
          <>
            <div className="stats">
              <Stat label="Held back in these dates" value={`₹${inr(r.totals.tds)}`} hint={`on ₹${inr(r.totals.gross)} settled`} />
              <Stat label="Tax paid for us, not yet claimed" value={`₹${inr(r.balance_now)}`} hint="all dates · check it against the tax statement" />
            </div>
            <Table rows={r.data} empty="No customer held back TDS in these dates." rowHref={(d) => `/payments/${d.id}`} columns={[
              { key: 'date', title: 'Date', render: (d) => date(d.date) }, { key: 'receipt_no', title: 'Receipt' },
              { key: 'customer', title: 'Customer' }, { key: 'pan', title: 'PAN' }, { key: 'invoices', title: 'Against' },
              { key: 'gross', title: 'Settled', align: 'right', render: (d) => inr(d.gross) },
              { key: 'received', title: 'Received', align: 'right', render: (d) => inr(d.received) },
              { key: 'tds', title: 'TDS', align: 'right', render: (d) => <strong>{inr(d.tds)}</strong> },
            ]} />
          </>
        )}
      </Card>

      <Toggle label="Kinds of payment and their rates">
        <p className="muted small">
          These are the rates in general use. From 1 April 2026 the law lists them in section 393 of the Income-tax Act, 2025; the earlier section is
          shown so each can be recognised. Change a rate, switch one off, or fill in the code the return asks for. What has already been recorded keeps its own figure.
        </p>
        <Table rows={rates.data?.data} columns={[
          { key: 'name', title: 'Kind of payment' }, { key: 'law_reference', title: 'In the law' }, { key: 'return_code', title: 'Code on the return' },
          { key: 'rate', title: 'Rate', align: 'right', render: (x) => `${num(x.rate)}%` },
          { key: 'active', title: '', render: (x) => (x.active ? null : <Badge value="switched_off" />) },
          { key: 'x', title: '', render: (x) => (write ? <RateEditor rate={x} onDone={rates.reload} /> : null) },
        ]} />
        {write && (
          <Form inline submit="Add a kind" fields={[
            { name: 'name', label: 'Kind of payment', required: true }, { name: 'rate', label: 'Rate %', type: 'number', step: '0.01', required: true },
            { name: 'law_reference', label: 'In the law' }, { name: 'return_code', label: 'Code on the return' },
          ]} onSubmit={(v) => post('/tds/rates', v)} onDone={rates.reload} />
        )}
      </Toggle>
    </>
  );
}

function RateEditor({ rate, onDone }: { rate: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Change</button>;
  return (
    <Form inline submit="Save" initial={{ rate: Number(rate.rate), return_code: rate.return_code ?? '', law_reference: rate.law_reference ?? '', active: rate.active }}
      fields={[
        { name: 'rate', label: 'Rate %', type: 'number', step: '0.01', required: true }, { name: 'law_reference', label: 'In the law' },
        { name: 'return_code', label: 'Code on the return' }, { name: 'active', label: 'In use', type: 'checkbox' },
      ]}
      onSubmit={(v) => patch(`/tds/rates/${rate.id}`, v)} onDone={() => { setOpen(false); onDone(); }} />
  );
}
