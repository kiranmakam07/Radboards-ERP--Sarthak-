'use client';

import Link from 'next/link';
import { LEAD_STAGE_LABELS, OPEN_LEAD_STAGES, type LeadStage } from '@radcore/shared';
import { BarList, ChartCard, LineChart, MeterList, compactRupees, fillDays, plural, rupees } from '@/components/charts';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, inr, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const sum = (rows: any[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

export default function SalesDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/dashboards/sales${query}`);
  const d = data?.data;
  return (
    <Page title="Sales dashboard">
      {picker}
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Sales today" value={`₹${inr(sum(d.sales_today, 'value'))}`} hint={plural(sum(d.sales_today, 'invoices'), 'invoice')} />
            <Stat label="This week" value={`₹${inr(sum(d.sales_this_week, 'value'))}`} hint={plural(sum(d.sales_this_week, 'invoices'), 'invoice')} />
            <Stat label="Month to date" value={`₹${inr(sum(d.sales_month_to_date, 'value'))}`} hint={plural(sum(d.sales_month_to_date, 'invoices'), 'invoice')} />
            <Stat label="Walk-ins today" value={d.walk_ins_today.total} hint={`${d.walk_ins_today.purchases} bought · ${d.walk_ins_today.enquiries} enquiring`} />
          </div>

          <ChartCard title={`Sales per day, ${date(d.range.from)} to ${date(d.range.to)}`} table={
            <Table rows={d.sales_by_day} empty="No sales in this period." columns={[
              { key: 'day', title: 'Day', render: (r) => date(r.day) }, { key: 'invoices', title: 'Invoices', align: 'right' },
              { key: 'value', title: 'Sales', align: 'right', render: (r) => inr(r.value) },
            ]} />
          }>
            <LineChart name="sales" format={rupees} axisFormat={compactRupees} empty="No sales in this period."
              points={fillDays(d.sales_by_day.map((r: any) => ({ day: r.day, value: Number(r.value) })), d.range.from, d.range.to)} />
          </ChartCard>

          <div className="grid">
            <ChartCard title="Sales by channel">
              <BarList format={rupees} empty="No sales in this period."
                data={d.sales_in_range.map((r: any) => ({ label: label(r.channel), value: Number(r.value), note: plural(r.invoices, 'invoice') }))} />
            </ChartCard>

            <ChartCard title="Open leads by stage" actions={<Link href="/leads/pipeline">Open pipeline</Link>}>
              <BarList empty="No open leads."
                data={OPEN_LEAD_STAGES.map((stage: LeadStage) => {
                  const row = d.pipeline.find((p: any) => p.stage === stage);
                  return { label: LEAD_STAGE_LABELS[stage], value: row?.count ?? 0, note: row ? `₹${inr(row.value)}` : undefined, href: `/leads?stage=${stage}` };
                })} />
            </ChartCard>

            <ChartCard title="Top items by revenue">
              <BarList format={rupees} empty="No sales in this period."
                data={d.top_items.map((r: any) => ({ label: r.item, value: Number(r.revenue), note: `${num(r.qty)} sold` }))} />
            </ChartCard>

            <ChartCard title="Top dealers by revenue">
              <BarList format={rupees} empty="No dealer sales in this period."
                data={d.top_dealers.map((r: any) => ({ label: r.name, value: Number(r.revenue), href: `/parties/${r.party_id}` }))} />
            </ChartCard>

            <ChartCard title="Dealer outstanding against credit limit">
              <MeterList format={rupees} empty="No dealers yet."
                data={d.dealer_outstanding.map((r: any) => ({
                  label: r.name, value: Number(r.outstanding), limit: r.credit_limit === null ? null : Number(r.credit_limit), href: `/parties/${r.party_id}`,
                }))} />
            </ChartCard>

            <Card title="Follow-ups" actions={<Link href="/leads?view=followups_due">See leads</Link>}>
              <Table rows={d.follow_ups} empty="Nothing due." columns={[
                { key: 'owner', title: 'Salesperson' }, { key: 'due_today', title: 'Due today', align: 'right' },
                { key: 'overdue', title: 'Overdue', align: 'right', render: (r) => (r.overdue ? <span className="error small">{r.overdue}</span> : 0) },
              ]} />
            </Card>

            <Card title="Conversion by salesperson">
              <Table rows={d.conversion} empty="No leads in this period." columns={[
                { key: 'owner', title: 'Salesperson' }, { key: 'leads', title: 'Leads', align: 'right' }, { key: 'converted', title: 'Converted', align: 'right' },
                { key: 'lost', title: 'Lost', align: 'right' },
                { key: 'conversion_pct', title: 'Conversion', align: 'right', render: (r) => (r.conversion_pct === null ? '' : `${num(r.conversion_pct)}%`) },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
