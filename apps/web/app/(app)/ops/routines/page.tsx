'use client';

import { useState } from 'react';
import { TASK_FREQUENCIES, WEEKDAY_LABELS } from '@radcore/shared';
import { plural } from '@/components/charts';
import { scheduleText } from '@/components/ops';
import { ActionButton, Badge, Card, Form, Loading, Notice, Page, Table, Toggle, date, type Field } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const FREQUENCY_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', need_based: 'When needed' };
// Monday first, the way the working week runs.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const lines = (v: unknown) => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

function fields(people: { value: string; label: string }[]): Field[] {
  return [
    { name: 'title', label: 'What needs doing', required: true },
    { name: 'assignee_id', label: 'Who does it', type: 'select', required: true, options: people },
    { name: 'frequency', label: 'How often', type: 'select', required: true, options: TASK_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f]! })) },
    { name: 'month_day', label: 'Day of the month', type: 'number', step: '1', help: 'For monthly. 31 means the last day' },
    ...DAY_ORDER.map((d): Field => ({ name: `d${d}`, label: WEEKDAY_LABELS[d]!, type: 'checkbox' })),
    { name: 'checklist', label: 'Checklist (one step per line)', type: 'textarea' },
    { name: 'description', label: 'Details', type: 'textarea' },
  ];
}

/** Form values -> API body. The weekday boxes only matter for daily and weekly routines. */
function body({ checklist, month_day, ...v }: Record<string, any>) {
  const out: Record<string, unknown> = { title: v.title, assignee_id: v.assignee_id, frequency: v.frequency, description: v.description, checklist: lines(checklist) };
  out.weekdays = DAY_ORDER.filter((d) => v[`d${d}`]);
  out.month_day = month_day;
  return out;
}

export default function RoutinesPage() {
  const can = useCan();
  const manage = can('ops:manage');
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/ops/templates');
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const people = (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));
  const editing = data?.data.find((t) => t.id === editId);
  const days = (weekdays: number[]) => Object.fromEntries(DAY_ORDER.map((d) => [`d${d}`, weekdays.includes(d)]));

  return (
    <Page title="Routines">
      <p className="muted">Work that repeats. Each routine creates its task for the right person on the right day, with its checklist; nobody has to remember to send it.</p>
      <Notice>{notice}</Notice>
      {manage && (
        <Toggle label="+ New routine">
          <Form submit="Save routine"
            initial={{ frequency: 'daily', ...days([1, 2, 3, 4, 5, 6]) }}
            fields={fields(people)}
            onSubmit={(v) => post('/ops/templates', body(v))}
            onDone={reload} />
        </Toggle>
      )}
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No routines yet." columns={[
        { key: 'title', title: 'Routine', render: (r) => (manage ? <button type="button" className="link" onClick={() => setEditId(editId === r.id ? null : r.id)}>{r.title}</button> : r.title) },
        { key: 'frequency', title: 'When', render: (r) => scheduleText(r) },
        { key: 'assignee_name', title: 'Who' },
        { key: 'checklist', title: 'Checklist', align: 'right', render: (r) => (r.checklist.length ? plural(r.checklist.length, 'step') : '') },
        { key: 'open_tasks', title: 'Open tasks', align: 'right' },
        { key: 'last_raised_for', title: 'Last task for', render: (r) => date(r.last_raised_for) },
        { key: 'active', title: 'Status', render: (r) => <Badge value={r.active ? 'active' : 'off'} /> },
        { key: 'actions', title: '', render: (r) => (!manage ? null : (
          <>
            {r.active ? (
              <ActionButton onClick={() => post(`/ops/templates/${r.id}/raise`, {})}
                onDone={() => { setNotice(`"${r.title}" raised for ${r.assignee_name}, due today.`); reload(); }}>Raise now</ActionButton>
            ) : null}{' '}
            <ActionButton onClick={() => patch(`/ops/templates/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton>
          </>
        )) },
      ]} />

      {editing && (
        <Card title={`Edit: ${editing.title}`}>
          <p className="muted small">Changes apply to tasks created from now on; tasks already created stay as they are.</p>
          <Form key={editing.updated_at} submit="Save changes"
            initial={{
              title: editing.title, assignee_id: editing.assignee_id, frequency: editing.frequency, month_day: editing.month_day ?? '',
              ...days(editing.weekdays), checklist: editing.checklist.join('\n'), description: editing.description ?? '',
            }}
            fields={fields(people)}
            onSubmit={(v) => patch(`/ops/templates/${editing.id}`, body(v))}
            onDone={() => { setEditId(null); reload(); }} />
        </Card>
      )}
    </Page>
  );
}
