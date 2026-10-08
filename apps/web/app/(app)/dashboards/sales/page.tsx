'use client';

import Link from 'next/link';
import { LEAD_STAGE_LABELS, type LeadStage } from '@radcore/shared';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, inr, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const sum = (rows: any[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
const channelTable = (rows: any[]) => (
  <Table rows={rows} empty="No sales." columns={[
    { key: 'channel', title: 'Channel', render: (r) => label(r.channel) }, { key: 'invoices', title: 'Invoices', align: 'right' },
    { key: 'value', title: 'Value', align: 'right', render: (r) => inr(r.value) },
  ]} />
);

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
            <Stat label="Sales today" value={`₹${inr(sum(d.sales_today, 'value'))}`} hint={`${sum(d.sales_today, 'invoices')} invoices`} />
            <Stat label="This week" value={`₹${inr(sum(d.sales_this_week, 'value'))}`} hint={`${sum(d.sales_this_week, 'invoices')} invoices`} />
            <Stat label="Month to date" value={`₹${inr(sum(d.sales_month_to_date, 'value'))}`} hint={`${sum(d.sales_month_to_date, 'invoices')} invoices`} />
            <Stat label="Walk-ins today" value={d.walk_ins_today.total} hint={`${d.walk_ins_today.purchases} bought · ${d.walk_ins_today.enquiries} enquiring`} />
          </div>
          <div className="grid">
            <Card title="Sales by channel (selected period)">{channelTable(d.sales_in_range)}</Card>
            <Card title="Pipeline by stage" actions={<Link href="/leads/pipeline">Open pipeline</Link>}>
              <Table rows={d.pipeline} empty="No open leads." columns={[
                { key: 'stage', title: 'Stage', render: (r) => <Link href={`/leads?stage=${r.stage}`}>{LEAD_STAGE_LABELS[r.stage as LeadStage]}</Link> },
                { key: 'count', title: 'Leads', align: 'right' }, { key: 'value', title: 'Value', align: 'right', render: (r) => inr(r.value) },
              ]} />
            </Card>
            <Card title="Follow-ups" actions={<Link href="/leads?view=followups_due">See leads</Link>}>
              <Table rows={d.follow_ups} empty="Nothing due." columns={[
                { key: 'owner', title: 'Salesperson' }, { key: 'due_today', title: 'Due today', align: 'right' },
                { key: 'overdue', title: 'Overdue', align: 'right', render: (r) => (r.overdue ? <span className="error small">{r.overdue}</span> : 0) },
              ]} />
            </Card>
            <Card title="Conversion by salesperson">
              <Table rows={d.conversion} empty="No leads in this period." columns={[
                { key: 'owner', title: 'Salesperson' }, { key: 'leads', title: 'Leads', align: 'right' }, { key: 'converted', title: 'Converted', align: 'right' },
                { key: 'lost', title: 'Lost', align: 'right' }, { key: 'conversion_pct', title: 'Conversion', align: 'right', render: (r) => (r.conversion_pct === null ? '' : `${num(r.conversion_pct)}%`) },
              ]} />
            </Card>
            <Card title="Top items">
              <Table rows={d.top_items} empty="No sales." columns={[
                { key: 'item', title: 'Item' }, { key: 'qty', title: 'Qty', align: 'right', render: (r) => num(r.qty) },
                { key: 'revenue', title: 'Revenue (excl. GST)', align: 'right', render: (r) => inr(r.revenue) },
              ]} />
            </Card>
            <Card title="Top dealers">
              <Table rows={d.top_dealers} empty="No dealer sales." rowHref={(r) => `/parties/${r.party_id}`} columns={[
                { key: 'name', title: 'Dealer' }, { key: 'revenue', title: 'Revenue', align: 'right', render: (r) => inr(r.revenue) },
              ]} />
            </Card>
            <Card title="Dealer outstanding vs credit limit">
              <Table rows={d.dealer_outstanding} empty="No dealers yet." rowHref={(r) => `/parties/${r.party_id}`} columns={[
                { key: 'name', title: 'Dealer' }, { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
                { key: 'credit_limit', title: 'Limit', align: 'right', render: (r) => inr(r.credit_limit) },
                { key: 'used_pct', title: 'Used', align: 'right', render: (r) => (r.used_pct === null ? '' : <span className={Number(r.used_pct) >= 90 ? 'error small' : undefined}>{num(r.used_pct)}%</span>) },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
