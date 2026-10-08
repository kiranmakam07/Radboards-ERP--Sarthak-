'use client';

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

  // Pivot leads-by-day into one row per day.
  const days: Record<string, Record<string, number>> = {};
  for (const r of d?.leads_by_day ?? []) (days[r.day] ??= {})[r.source] = r.leads;
  const sources = [...new Set((d?.leads_by_day ?? []).map((r: any) => r.source as string))] as string[];
  const footfall: Record<string, { walk_ins: number; purchases: number }> = {};
  for (const r of d?.walk_in_footfall ?? []) {
    const f = (footfall[r.hour] ??= { walk_ins: 0, purchases: 0 });
    f.walk_ins += r.walk_ins; f.purchases += r.purchases;
  }

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
          <div className="grid">
            <Card title="By source">
              <Table rows={d.by_source} columns={[
                { key: 'source', title: 'Source' }, { key: 'leads', title: 'Leads', align: 'right' }, { key: 'converted', title: 'Converted', align: 'right' },
                { key: 'lost', title: 'Lost', align: 'right' },
                { key: 'conversion_pct', title: 'Conversion', align: 'right', render: (r) => (r.conversion_pct === null ? '' : `${num(r.conversion_pct)}%`) },
                { key: 'revenue', title: 'Revenue', align: 'right', render: (r) => inr(r.revenue) },
              ]} />
            </Card>
            <Card title="By campaign">
              <Table rows={d.leads_by_campaign} empty="No leads in this period." columns={[
                { key: 'source', title: 'Source' }, { key: 'campaign', title: 'Campaign / detail' }, { key: 'leads', title: 'Leads', align: 'right' },
                { key: 'converted', title: 'Converted', align: 'right' },
              ]} />
            </Card>
            <Card title="Leads per day">
              <Table rows={Object.entries(days).map(([day, counts]) => ({ day, ...counts }))} empty="No leads in this period." columns={[
                { key: 'day', title: 'Day', render: (r) => date(r.day) },
                ...sources.map((s) => ({ key: s, title: s, align: 'right' as const, render: (r: any) => r[s] ?? '' })),
              ]} />
            </Card>
            <Card title="Lost reasons">
              <Table rows={d.lost_reasons} empty="No lost leads in this period." columns={[{ key: 'reason', title: 'Reason' }, { key: 'leads', title: 'Leads', align: 'right' }]} />
            </Card>
            <Card title="Walk-in footfall by hour">
              <Table rows={Object.entries(footfall).map(([hour, f]) => ({ hour, ...f }))} empty="No walk-ins in this period." columns={[
                { key: 'hour', title: 'Hour', render: (r) => `${String(r.hour).padStart(2, '0')}:00` },
                { key: 'walk_ins', title: 'Walk-ins', align: 'right' }, { key: 'purchases', title: 'Bought', align: 'right' },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
