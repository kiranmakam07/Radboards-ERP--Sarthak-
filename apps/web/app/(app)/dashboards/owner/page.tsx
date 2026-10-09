'use client';

import Link from 'next/link';
import { addDays } from '@radcore/shared';
import { BarList, ChartCard, Flow, LineChart, compactRupees, fillDays, plural, rupees } from '@/components/charts';
import { Loading, Page, Stat, Table, date, inr, label } from '@/components/ui';
import { useGet } from '@/lib/api';

/** Percentage change against a base, in words: "12% up on", "8% down on", or nothing when there is no base. */
function versus(now: number, before: number, what: string): string {
  if (before <= 0) return now > 0 ? `nothing in ${what}` : `same as ${what}`;
  const change = Math.round(((now - before) / before) * 100);
  return change === 0 ? `level with ${what}` : `${Math.abs(change)}% ${change > 0 ? 'up on' : 'down on'} ${what}`;
}

/** The whole business on one page. Every figure links to the screen behind it. */
export default function OwnerSummary() {
  const { data, loading, error } = useGet<{ data: any }>('/dashboards/owner');
  const d = data?.data;
  const money = d?.money;
  const mtd = d ? Number(d.sales.month_to_date.value) : 0;
  const before = d ? Number(d.sales.last_month_same_days.value) : 0;

  return (
    <Page title="Owner's summary">
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Sales today" value={`₹${inr(d.sales.today.value)}`} hint={plural(d.sales.today.invoices, 'invoice')} />
            <Stat label="Sales this month" value={`₹${inr(mtd)}`} hint={versus(mtd, before, 'the same days last month')} />
            <Stat label="Collected this month" value={`₹${inr(money.collected_this_month)}`} hint={<Link href="/dashboards/accounts">Accounts dashboard</Link>} />
            <Stat label={Number(money.profit_this_month) >= 0 ? 'Profit this month' : 'Loss this month'} value={`₹${inr(Math.abs(Number(money.profit_this_month)))}`}
              hint={`${Number(money.profit_this_year) >= 0 ? 'profit' : 'loss'} of ₹${inr(Math.abs(Number(money.profit_this_year)))} this financial year`} />
          </div>
          <div className="stats">
            <Stat label="Cash and bank" value={`₹${inr(money.cash_and_bank)}`} />
            <Stat label="Customers owe us" value={`₹${inr(money.receivables.total)}`}
              hint={Number(money.receivables.overdue) > 0 ? <span className="error small">₹{inr(money.receivables.overdue)} overdue</span> : 'nothing overdue'} />
            <Stat label="We owe suppliers" value={`₹${inr(money.payables.total)}`}
              hint={Number(money.payables.overdue) > 0 ? <span className="error small">₹{inr(money.payables.overdue)} overdue</span> : 'nothing overdue'} />
            <Stat label="Stock value" value={`₹${inr(money.stock_value)}`} hint={<Link href="/dashboards/stores">Stores dashboard</Link>} />
            <Stat label="GST this month (est.)" value={`₹${inr(money.gst_this_month)}`} hint="output tax less input credit" />
          </div>

          <ChartCard title="Sales per day, last 30 days" actions={<Link href="/dashboards/sales">Sales dashboard</Link>} table={
            <Table rows={d.sales.by_day} empty="No sales in the last 30 days." columns={[
              { key: 'day', title: 'Day', render: (r) => date(r.day) }, { key: 'value', title: 'Sales', align: 'right', render: (r) => inr(r.value) },
            ]} />
          }>
            <LineChart name="sales" format={rupees} axisFormat={compactRupees} empty="No sales in the last 30 days."
              points={fillDays(d.sales.by_day.map((r: any) => ({ day: r.day, value: Number(r.value) })), addDays(d.today, -29), d.today)} />
          </ChartCard>

          <div className="grid">
            <ChartCard title="Sales this month, by channel">
              <BarList format={rupees} empty="No sales yet this month."
                data={d.sales.by_channel.map((c: any) => ({ label: label(c.channel), value: Number(c.value), note: plural(c.invoices, 'invoice') }))} />
            </ChartCard>
          </div>

          <Flow title="Customers" arrows={false} steps={[
            { label: 'Leads this month', value: d.leads.this_month, note: d.leads.conversion_pct !== null ? `${Number(d.leads.conversion_pct)}% converted` : undefined, href: '/dashboards/marketing' },
            { label: 'Leads not yet contacted', value: d.leads.not_contacted, href: '/leads?stage=new', alert: d.leads.not_contacted > 0 },
            { label: 'Quotes waiting', value: d.orders.quotes, href: '/sales/orders' },
            { label: 'Orders to deliver', value: d.orders.to_deliver, href: '/sales/orders' },
            { label: 'Delivered, to invoice', value: d.orders.to_invoice, href: '/sales/orders', alert: d.orders.to_invoice > 0 },
          ]} />
          <Flow title="Stores" arrows={false} steps={[
            { label: 'Items low on stock', value: d.stores.low_stock, href: '/dashboards/stores', alert: d.stores.low_stock > 0 },
            { label: 'Orders with suppliers', value: d.stores.awaiting_goods, href: '/purchasing/orders' },
            { label: 'Waiting for QC', value: d.stores.waiting_qc, href: '/purchasing/receipts', alert: d.stores.waiting_qc > 0 },
          ]} />
          <Flow title="People and operations" arrows={false} steps={[
            { label: 'In today', value: d.people.in_today, note: `of ${d.people.on_rolls} on the rolls`, href: '/hr/attendance' },
            { label: 'Open positions', value: d.people.open_positions, note: `${d.people.applicants_in_progress} applicants in progress`, href: '/dashboards/hr' },
            { label: 'Late tasks', value: d.operations.late_tasks, note: `${d.operations.open_today} still open today`, href: '/ops/tasks?view=overdue', alert: d.operations.late_tasks > 0 },
            { label: 'Maintenance overdue', value: d.operations.maintenance_overdue, href: '/ops/assets', alert: d.operations.maintenance_overdue > 0 },
            { label: 'Projects running', value: d.operations.projects_running, note: d.operations.projects_overdue ? `${d.operations.projects_overdue} past deadline` : undefined, href: '/ops/projects', alert: d.operations.projects_overdue > 0 },
          ]} />
        </>
      )}
    </Page>
  );
}
