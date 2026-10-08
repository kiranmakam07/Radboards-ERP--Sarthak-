'use client';

import Link from 'next/link';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, inr } from '@/components/ui';
import { useGet } from '@/lib/api';

export default function AccountsDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/dashboards/accounts${query}`);
  const d = data?.data;
  return (
    <Page title="Accounts dashboard">
      {picker}
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Invoiced" value={`₹${inr(d.invoiced_vs_collected.invoiced)}`} />
            <Stat label="Collected" value={`₹${inr(d.invoiced_vs_collected.collected)}`} />
            <Stat label="Receivables" value={`₹${inr(d.receivables.total)}`} hint={<Link href="/accounts/reports">Ageing report</Link>} />
            <Stat label="Payables" value={`₹${inr(d.payables.total)}`} hint={`₹${inr(d.payables.overdue)} overdue · ₹${inr(d.payables.due_this_week)} due this week`} />
            <Stat label="GST this month (est.)" value={`₹${inr(d.gst_this_month.net_payable.total)}`}
              hint={`Output ₹${inr(d.gst_this_month.outward.total_tax)} − ITC ₹${inr(d.gst_this_month.itc.total_tax)}`} />
            <Stat label={Number(d.profit_and_loss.net_profit) >= 0 ? 'Net profit' : 'Net loss'} value={`₹${inr(Math.abs(Number(d.profit_and_loss.net_profit)))}`}
              hint={`Income ₹${inr(d.profit_and_loss.income)} − Expenses ₹${inr(d.profit_and_loss.expense)}`} />
          </div>
          <div className="grid">
            <Card title="Cash & bank">
              <Table rows={d.cash_and_bank} columns={[{ key: 'name', title: 'Account' }, { key: 'balance', title: 'Balance', align: 'right', render: (r) => inr(r.balance) }]} />
            </Card>
            <Card title="Receivables by age">
              <Table rows={[
                { bucket: '0–30 days', amount: d.receivables.d0_30 }, { bucket: '31–60 days', amount: d.receivables.d31_60 },
                { bucket: '61–90 days', amount: d.receivables.d61_90 }, { bucket: '90+ days', amount: d.receivables.d90_plus },
              ]} columns={[{ key: 'bucket', title: 'Age' }, { key: 'amount', title: 'Outstanding', align: 'right', render: (r) => inr(r.amount) }]} />
            </Card>
            <Card title="Top debtors">
              <Table rows={d.top_debtors} empty="Nobody owes us anything." rowHref={(r) => (r.party_id ? `/parties/${r.party_id}` : null)} columns={[
                { key: 'name', title: 'Party' }, { key: 'oldest_due', title: 'Oldest due', render: (r) => date(r.oldest_due) },
                { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
              ]} />
            </Card>
            <Card title="Supplier bills due or overdue">
              <Table rows={d.overdue_bills} empty="Nothing due this week." rowHref={(r) => `/purchasing/bills/${r.bill_id}`} columns={[
                { key: 'bill_no', title: 'Bill' }, { key: 'supplier', title: 'Supplier' }, { key: 'due_date', title: 'Due', render: (r) => date(r.due_date) },
                { key: 'days_overdue', title: 'Overdue', align: 'right', render: (r) => (Number(r.days_overdue) > 0 ? `${r.days_overdue} d` : '') },
                { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
              ]} />
            </Card>
            <Card title="Expenses by category (month to date)">
              <Table rows={d.expenses_by_category} empty="No expenses this month." columns={[
                { key: 'category', title: 'Category' }, { key: 'count', title: 'Entries', align: 'right' }, { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
