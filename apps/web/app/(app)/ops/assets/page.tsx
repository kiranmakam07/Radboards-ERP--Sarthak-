'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ASSET_STATUSES } from '@radcore/shared';
import { MaintenanceDone, Due, everyText } from '@/components/ops';
import { Badge, Card, CsvLink, Form, Loading, Page, Table, Toggle, date, inr, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function AssetsPage() {
  const can = useCan();
  const manage = can('ops:manage');
  const [f, setF] = useState({ q: '', status: '' });
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const path = `/ops/assets${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const due = useGet<{ data: any[] }>('/ops/maintenance?view=due');

  return (
    <Page title="Assets & maintenance" actions={<CsvLink href={path} />}>
      <Card title="Maintenance due now or soon" actions={<a href="/api/ops/maintenance?format=csv">Export all schedules</a>}>
        <Loading loading={due.loading} error={due.error} />
        <Table rows={due.data?.data} empty="Nothing is due. Reminders appear here ahead of each due date." columns={[
          { key: 'asset_name', title: 'Asset', render: (r) => <Link href={`/ops/assets/${r.asset_id}`}>{r.asset_name}</Link> },
          { key: 'title', title: 'Work' },
          { key: 'interval', title: 'How often', render: (r) => everyText(r) },
          { key: 'state', title: 'Due', render: (r) => <Due schedule={r} /> },
          { key: 'last_done_on', title: 'Last done', render: (r) => date(r.last_done_on) },
          { key: 'assignee_name', title: 'Looked after by' },
          { key: 'actions', title: '', render: (r) => (manage ? <button type="button" onClick={() => setDoneFor(doneFor === r.id ? null : r.id)}>Mark done</button> : null) },
        ]} />
        {doneFor ? <div className="toggle-body"><MaintenanceDone scheduleId={doneFor} onDone={() => { setDoneFor(null); due.reload(); reload(); }} /></div> : null}
      </Card>

      {manage && (
        <Toggle label="+ Add asset">
          <Form submit="Save asset"
            fields={[
              { name: 'name', label: 'Name', required: true, placeholder: 'e.g. CNC Router' },
              { name: 'category', label: 'Kind', required: true, placeholder: 'Machine, Vehicle, Computer…' },
              { name: 'location', label: 'Where it is kept' },
              { name: 'serial_no', label: 'Serial / registration no.' },
              { name: 'purchase_date', label: 'Bought on', type: 'date' },
              { name: 'purchase_cost', label: 'Cost', type: 'number' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onSubmit={(v) => post('/ops/assets', v)}
            onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, number, kind" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No assets yet." rowHref={(r) => `/ops/assets/${r.id}`} columns={[
        { key: 'asset_no', title: 'No.' },
        { key: 'name', title: 'Asset' },
        { key: 'category', title: 'Kind' },
        { key: 'location', title: 'Where' },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'schedules', title: 'Schedules', align: 'right' },
        { key: 'next_due_on', title: 'Next due', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{date(r.next_due_on)}</span> },
        { key: 'last_serviced_on', title: 'Last serviced', render: (r) => date(r.last_serviced_on) },
        { key: 'maintenance_cost', title: 'Spent on upkeep', align: 'right', render: (r) => (Number(r.maintenance_cost) ? inr(r.maintenance_cost) : '') },
      ]} />
    </Page>
  );
}
