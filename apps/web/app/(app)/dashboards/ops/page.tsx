'use client';

import Link from 'next/link';
import { addDays } from '@radcore/shared';
import { BarList, ChartCard, ColumnChart, Flow, rupees } from '@/components/charts';
import { dueText, everyText } from '@/components/ops';
import { Badge, Card, Loading, Page, Stat, Table, date, label } from '@/components/ui';
import { useGet } from '@/lib/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function OpsDashboard() {
  const { data, loading, error } = useGet<{ data: any }>('/ops/dashboard');
  const d = data?.data;

  // The last 14 days, one column each, including days with no tasks.
  const days = d ? Array.from({ length: 14 }, (_, i) => {
    const day = addDays(d.today, i - 13);
    const row = d.tasks_by_day.find((r: any) => r.day === day);
    const dom = Number(day.slice(8, 10));
    return {
      day, label: i === 0 || dom === 1 ? `${dom} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : String(dom),
      values: [row?.done ?? 0, row?.skipped ?? 0, row?.open ?? 0],
    };
  }) : [];
  const anyTasks = days.some((x) => x.values.some((v) => v > 0));

  return (
    <Page title="Operations dashboard">
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <Flow title="Today" arrows={false} steps={[
            { label: 'Tasks still open today', value: d.tasks_today.open, note: `${d.tasks_today.done} of ${d.tasks_today.total} done`, href: '/ops/tasks?view=today' },
            { label: 'Late tasks', value: d.overdue.count, note: d.overdue.oldest ? `oldest from ${date(d.overdue.oldest)}` : undefined, href: '/ops/tasks?view=overdue', alert: d.overdue.count > 0 },
            { label: 'Maintenance overdue', value: d.maintenance.overdue, href: '/ops/assets', alert: d.maintenance.overdue > 0 },
            { label: 'Maintenance due soon', value: d.maintenance.due_soon, href: '/ops/assets' },
          ]} />

          <div className="stats">
            <Stat label="Tasks for today" value={d.tasks_today.total} hint={`${d.tasks_today.done} done · ${d.tasks_today.skipped} could not be done`} />
            <Stat label="Assets" value={d.assets_by_status.reduce((s: number, r: any) => s + r.count, 0)}
              hint={d.assets_by_status.map((r: any) => `${r.count} ${label(r.status).toLowerCase()}`).join(' · ') || undefined} />
            <Stat label="Spent on upkeep, last 12 months" value={rupees(Number(d.maintenance_spend.last_12_months))} />
          </div>

          <ChartCard title="Tasks over the last 14 days, by how they ended" table={
            <Table rows={days} columns={[
              { key: 'day', title: 'Day', render: (r) => date(r.day) },
              { key: 'done', title: 'Done', align: 'right', render: (r) => r.values[0] },
              { key: 'skipped', title: 'Could not be done', align: 'right', render: (r) => r.values[1] },
              { key: 'open', title: 'Still open', align: 'right', render: (r) => r.values[2] },
            ]} />
          }>
            <ColumnChart data={anyTasks ? days : []} series={['Done', 'Could not be done', 'Still open']} empty="No tasks in the last 14 days. Set up routines and they will appear here." />
          </ChartCard>

          <div className="grid">
            <ChartCard title="Late tasks, by person" actions={<Link href="/ops/tasks?view=overdue">See them</Link>}>
              <BarList empty="Nobody has a late task."
                data={d.by_person.filter((p: any) => p.overdue > 0).map((p: any) => ({ label: p.name, value: p.overdue, note: p.open_today ? `${p.open_today} more due today` : undefined }))} />
            </ChartCard>

            <Card title="The last 30 days, by person">
              <Table rows={d.by_person} empty="No tasks yet." columns={[
                { key: 'name', title: 'Person' },
                { key: 'assigned_30_days', title: 'Given', align: 'right' },
                { key: 'done_30_days', title: 'Done', align: 'right' },
                { key: 'on_time', title: 'Done on the day', align: 'right', render: (r) => (r.done_30_days ? `${Math.round((r.on_time_30_days / r.done_30_days) * 100)}%` : '') },
                { key: 'overdue', title: 'Late now', align: 'right', render: (r) => (r.overdue ? <span className="error small">{r.overdue}</span> : 0) },
              ]} />
            </Card>
          </div>

          <Card title="Maintenance due now or soon" actions={<Link href="/ops/assets">Assets & maintenance</Link>}>
            <Table rows={d.maintenance_due} empty="Nothing is due." rowHref={(r) => `/ops/assets/${r.asset_id}`} columns={[
              { key: 'asset_name', title: 'Asset' },
              { key: 'title', title: 'Work' },
              { key: 'interval', title: 'How often', render: (r) => everyText(r) },
              { key: 'state', title: 'Due', render: (r) => <><Badge value={r.state} /> <span className="small">{dueText(r)}</span></> },
              { key: 'assignee_name', title: 'Looked after by' },
            ]} />
          </Card>
        </>
      )}
    </Page>
  );
}
