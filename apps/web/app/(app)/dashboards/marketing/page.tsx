'use client';

import { BarList, ChartCard, ColumnChart, LineChart, fillDays } from '@/components/charts';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, inr, num } from '@/components/ui';
import { useGet } from '@/lib/api';

export default function MarketingDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/dashboards/marketing${query}`);
  const d = data?.data;
  const total = d ? d.by_source.reduce((s: number, r: any) => s + r.leads, 0) : 0;
  const converted = d ? d.by_source.reduce((s: number, r: any) => s + r.converted, 0) : 0;
  const revenue = d ? d.by_source.reduce((s: number, r: any) => s + Number(r.revenue), 0) : 0;

  // Leads per day, all sources together.
  const perDay = new Map<string, number>();
  for (const r of d?.leads_by_day ?? []) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.leads);
  // Walk-ins by hour of the day, across the whole period.
  const hours = new Map<number, { walkIns: number; bought: number }>();
  for (const r of d?.walk_in_footfall ?? []) {
    const h = hours.get(r.hour) ?? { walkIns: 0, bought: 0 };
    h.walkIns += r.walk_ins; h.bought += r.purchases;
    hours.set(r.hour, h);
  }
  const hourKeys = [...hours.keys()];
  const footfall = hourKeys.length === 0 ? [] : Array.from({ length: Math.max(...hourKeys) - Math.min(...hourKeys) + 1 }, (_, i) => {
    const hour = Math.min(...hourKeys) + i;
    const h = hours.get(hour) ?? { walkIns: 0, bought: 0 };
    return { label: `${String(hour).padStart(2, '0')}:00`, values: [h.bought, h.walkIns - h.bought] };
  });

  return (
    <Page title="Marketing dashboard">
      {picker}
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Leads" value={total} />
            <Stat label="Converted" value={converted} hint={total ? `${((100 * converted) / total).toFixed(1)}% conversion` : undefined} />
            <Stat label="Attributed revenue" value={`₹${inr(revenue)}`} />
            <Stat label="Median response time" value={d.response_time.median_hours === null ? '—' : `${num(d.response_time.median_hours)} h`}
              hint={`${d.response_time.not_yet_contacted} not yet contacted`} />
          </div>

          <ChartCard title={`Leads per day, ${date(d.range.from)} to ${date(d.range.to)}`}>
            <LineChart name="leads" empty="No leads in this period."
              points={fillDays([...perDay].map(([day, value]) => ({ day, value })), d.range.from, d.range.to)} />
          </ChartCard>

          <div className="grid">
            <ChartCard title="Leads by source" table={
              <Table rows={d.by_source} columns={[
                { key: 'source', title: 'Source' }, { key: 'leads', title: 'Leads', align: 'right' }, { key: 'converted', title: 'Converted', align: 'right' },
                { key: 'lost', title: 'Lost', align: 'right' },
                { key: 'conversion_pct', title: 'Conversion', align: 'right', render: (r) => (r.conversion_pct === null ? '' : `${num(r.conversion_pct)}%`) },
                { key: 'revenue', title: 'Revenue', align: 'right', render: (r) => inr(r.revenue) },
              ]} />
            }>
              <BarList empty="No leads in this period."
                data={d.by_source.filter((r: any) => r.leads > 0).map((r: any) => ({
                  label: r.source, value: r.leads, note: `${r.converted} converted${Number(r.revenue) > 0 ? `, ₹${inr(r.revenue)}` : ''}`,
                }))} />
            </ChartCard>

            <ChartCard title="Why leads were lost">
              <BarList empty="No lost leads in this period." data={d.lost_reasons.map((r: any) => ({ label: r.reason, value: r.leads }))} />
            </ChartCard>

            <ChartCard title="Walk-ins by hour of the day" table={
              <Table rows={footfall} empty="No walk-ins in this period." columns={[
                { key: 'label', title: 'Hour' }, { key: 'bought', title: 'Bought', align: 'right', render: (r) => r.values[0] },
                { key: 'enquired', title: 'Only enquiring', align: 'right', render: (r) => r.values[1] },
              ]} />
            }>
              <ColumnChart data={footfall} series={['Bought', 'Only enquiring']} empty="No walk-ins in this period." />
            </ChartCard>

            <Card title="By campaign">
              <Table rows={d.leads_by_campaign} empty="No leads in this period." columns={[
                { key: 'source', title: 'Source' }, { key: 'campaign', title: 'Campaign / detail' }, { key: 'leads', title: 'Leads', align: 'right' },
                { key: 'converted', title: 'Converted', align: 'right' },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
