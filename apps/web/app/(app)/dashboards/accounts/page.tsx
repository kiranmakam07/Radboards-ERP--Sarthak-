'use client';

import Link from 'next/link';
import { BarList, ChartCard, ColumnChart, compactRupees, plural, rupees } from '@/components/charts';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, inr } from '@/components/ui';
import { useGet } from '@/lib/api';

export default function AccountsDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/dashboards/accounts${query}`);
  const d = data?.data;
  const ageing = d ? [
    { label: '0–30', values: [Number(d.receivables.d0_30)] }, { label: '31–60', values: [Number(d.receivables.d31_60)] },
    { label: '61–90', values: [Number(d.receivables.d61_90)] }, { label: 'Over 90', values: [Number(d.receivables.d90_plus)] },
  ] : [];
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
            <Stat label="Bank lines to reconcile" value={d.bank_unreconciled.lines}
              hint={<Link href="/accounts/bank">₹{inr(d.bank_unreconciled.amount)} unexplained</Link>} />
            <Stat label="GST this month (est.)" value={`₹${inr(d.gst_this_month.net_payable.total)}`}
              hint={`Output ₹${inr(d.gst_this_month.outward.total_tax)} − ITC ₹${inr(d.gst_this_month.itc.total_tax)}`} />
            <Stat label={Number(d.profit_and_loss.net_profit) >= 0 ? 'Net profit' : 'Net loss'} value={`₹${inr(Math.abs(Number(d.profit_and_loss.net_profit)))}`}
              hint={`Income ₹${inr(d.profit_and_loss.income)} − Expenses ₹${inr(d.profit_and_loss.expense)}`} />
          </div>
          <div className="grid">
            <ChartCard title="Money owed to us, by age in days" table={
              <Table rows={ageing} columns={[{ key: 'label', title: 'Age', render: (r) => `${r.label} days` }, { key: 'amount', title: 'Outstanding', align: 'right', render: (r) => inr(r.values[0]) }]} />
            }>
              <ColumnChart data={ageing} series={['Outstanding']} format={rupees} axisFormat={compactRupees} empty="Nobody owes us anything." />
            </ChartCard>

            <ChartCard title="Who owes the most">
              <BarList format={rupees} empty="Nobody owes us anything."
                data={d.top_debtors.map((r: any) => ({
                  label: r.name, value: Number(r.outstanding), note: r.oldest_due ? `due ${date(r.oldest_due)}` : undefined, href: r.party_id ? `/parties/${r.party_id}` : null,
                }))} />
            </ChartCard>

            <ChartCard title="Expenses by category, this month">
              <BarList format={rupees} empty="No expenses this month."
                data={d.expenses_by_category.map((r: any) => ({ label: r.category, value: Number(r.amount), note: plural(r.count, 'entry', 'entries') }))} />
            </ChartCard>

            <Card title="Cash & bank">
              <Table rows={d.cash_and_bank} columns={[{ key: 'name', title: 'Account' }, { key: 'balance', title: 'Balance', align: 'right', render: (r) => inr(r.balance) }]} />
            </Card>

            <Card title="Supplier bills due or overdue">
              <Table rows={d.overdue_bills} empty="Nothing due this week." rowHref={(r) => `/purchasing/bills/${r.bill_id}`} columns={[
                { key: 'bill_no', title: 'Bill' }, { key: 'supplier', title: 'Supplier' }, { key: 'due_date', title: 'Due', render: (r) => date(r.due_date) },
                { key: 'days_overdue', title: 'Overdue', align: 'right', render: (r) => (Number(r.days_overdue) > 0 ? `${r.days_overdue} d` : '') },
                { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
