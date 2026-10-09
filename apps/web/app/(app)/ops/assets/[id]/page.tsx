'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { INTERVAL_UNITS, istDate } from '@radcore/shared';
import { MaintenanceDone, dueText, everyText } from '@/components/ops';
import { ActionButton, Badge, Card, Form, KV, Loading, Page, Table, date, inr, label } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const manage = can('ops:manage');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/ops/assets/${id}`);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const a = data?.data;
  if (!a) return <Page title="Asset"><Loading loading={loading} error={error} /></Page>;
  const setStatus = (status: string) => patch(`/ops/assets/${id}`, { status });

  return (
    <Page title={`${a.asset_no} · ${a.name}`} actions={manage ? (
      <>
        {a.status === 'in_use' && <ActionButton onClick={() => setStatus('under_repair')} onDone={reload}>Mark under repair</ActionButton>}
        {a.status === 'under_repair' && <ActionButton onClick={() => setStatus('in_use')} onDone={reload}>Back in use</ActionButton>}
        {a.status !== 'retired' && (
          <ActionButton kind="danger" onClick={() => setStatus('retired')} onDone={reload} confirm="Retire this asset? Its maintenance reminders will stop.">Retire</ActionButton>
        )}
        {a.status === 'retired' && <ActionButton onClick={() => setStatus('in_use')} onDone={reload}>Bring back into use</ActionButton>}
      </>
    ) : null}>
      <Card>
        <KV rows={[
          ['Status', <Badge key="s" value={a.status} />],
          ['Kind', a.category], ['Where', a.location], ['Serial / registration', a.serial_no],
          ['Bought on', date(a.purchase_date)], ['Cost', a.purchase_cost ? `₹${inr(a.purchase_cost)}` : null],
          ['Notes', a.notes],
        ]} />
      </Card>

      <Card title="Maintenance schedules">
        <Table rows={a.schedules} empty="No schedule yet. Add one below and it will remind you ahead of each due date." columns={[
          { key: 'title', title: 'Work' },
          { key: 'interval', title: 'How often', render: (r) => everyText(r) },
          { key: 'state', title: 'Due', render: (r) => <><Badge value={r.state} /> <span className="small">{dueText(r)}</span></> },
          { key: 'last_done_on', title: 'Last done', render: (r) => date(r.last_done_on) },
          { key: 'assignee_name', title: 'Looked after by' },
          { key: 'remind_days_before', title: 'Reminder', render: (r) => `${r.remind_days_before} days ahead` },
          { key: 'actions', title: '', render: (r) => (!manage ? null : (
            <>
              {r.active ? <button type="button" onClick={() => setDoneFor(doneFor === r.id ? null : r.id)}>Mark done</button> : null}{' '}
              {a.status !== 'retired' ? (
                <ActionButton onClick={() => patch(`/ops/schedules/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton>
              ) : null}
            </>
          )) },
        ]} />
        {doneFor ? <div className="toggle-body"><MaintenanceDone scheduleId={doneFor} onDone={() => { setDoneFor(null); reload(); }} /></div> : null}
      </Card>

      {manage && a.status !== 'retired' && (
        <div className="grid">
          <Card title="Add a maintenance schedule">
            <Form submit="Add schedule"
              initial={{ interval_count: 6, interval_unit: 'months', remind_days_before: 7 }}
              fields={[
                { name: 'title', label: 'Work', required: true, placeholder: 'e.g. Full service' },
                { name: 'interval_count', label: 'Every', type: 'number', step: '1', required: true },
                { name: 'interval_unit', label: 'Days or months', type: 'select', required: true, options: INTERVAL_UNITS.map((u) => ({ value: u, label: label(u) })) },
                { name: 'last_done_on', label: 'Last done on', type: 'date', help: 'The next one is counted from here' },
                { name: 'next_due_on', label: 'Or: next due on', type: 'date', help: 'Use this to set the date yourself' },
                { name: 'assignee_id', label: 'Looked after by', type: 'select', help: 'They see it under My work', options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
                { name: 'remind_days_before', label: 'Remind this many days ahead', type: 'number', step: '1' },
                { name: 'instructions', label: 'Instructions', type: 'textarea' },
              ]}
              onSubmit={(v) => post(`/ops/assets/${id}/schedules`, v)}
              onDone={reload} />
          </Card>

          <Card title="Log a repair or one-off service">
            <Form submit="Save entry"
              initial={{ done_on: istDate() }}
              fields={[
                { name: 'done_on', label: 'Done on', type: 'date', required: true },
                { name: 'done_by', label: 'Done by', placeholder: 'Vendor or person' },
                { name: 'cost', label: 'Cost', type: 'number' },
                { name: 'notes', label: 'What was done', type: 'textarea', required: true },
              ]}
              onSubmit={(v) => post(`/ops/assets/${id}/logs`, v)}
              onDone={reload} />
          </Card>
        </div>
      )}

      <Card title="Service history">
        <Table rows={a.logs} empty="Nothing recorded yet." columns={[
          { key: 'done_on', title: 'Done on', render: (r) => date(r.done_on) },
          { key: 'schedule_title', title: 'Work', render: (r) => r.schedule_title ?? 'Repair / one-off' },
          { key: 'done_by', title: 'Done by' },
          { key: 'cost', title: 'Cost', align: 'right', render: (r) => inr(r.cost) },
          { key: 'notes', title: 'Notes', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.notes}</span> },
          { key: 'next_due_on', title: 'Next due set to', render: (r) => date(r.next_due_on) },
        ]} />
      </Card>
    </Page>
  );
}
