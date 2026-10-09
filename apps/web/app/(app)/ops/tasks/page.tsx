'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { TASK_STATUSES, istDate } from '@radcore/shared';
import { TaskCard } from '@/components/ops';
import { ActionButton, Badge, CsvLink, Form, Loading, Page, Table, Toggle, date, dateTime, label } from '@/components/ui';
import { patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const VIEWS: [string, string][] = [['today', 'Today'], ['overdue', 'Late'], ['', 'All']];

function Tasks() {
  const params = useSearchParams();
  const can = useCan();
  const manage = can('ops:manage');
  const [f, setF] = useState({ view: params.get('view') ?? 'today', status: '', assignee_id: '', q: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const path = `/ops/tasks${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const people = (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));
  const selected = data?.data.find((t) => t.id === openId);

  return (
    <Page title="Tasks" actions={<CsvLink href={path} />}>
      {manage && (
        <Toggle label="+ Give someone a one-off task">
          <p className="muted small">For work that repeats, set up a routine instead: its tasks then appear by themselves.</p>
          <Form submit="Give task"
            initial={{ due_date: istDate() }}
            fields={[
              { name: 'title', label: 'What needs doing', required: true },
              { name: 'assignee_id', label: 'Who', type: 'select', required: true, options: people },
              { name: 'due_date', label: 'By when', type: 'date', required: true },
              { name: 'checklist', label: 'Checklist (one step per line)', type: 'textarea' },
              { name: 'description', label: 'Details', type: 'textarea' },
            ]}
            onSubmit={({ checklist, ...v }) => post('/ops/tasks', { ...v, checklist: String(checklist ?? '').split('\n').map((s) => s.trim()).filter(Boolean) })}
            onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        {VIEWS.map(([v, l]) => <button key={v} type="button" className={f.view === v ? 'primary' : undefined} onClick={() => setF({ ...f, view: v })}>{l}</button>)}
        <input placeholder="Search task" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={f.assignee_id} onChange={(e) => setF({ ...f, assignee_id: e.target.value })}>
          <option value="">Anyone</option>{(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No tasks here." columns={[
        { key: 'due_date', title: 'Due', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{date(r.due_date)}</span> },
        { key: 'title', title: 'Task', render: (r) => <button type="button" className="link" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{r.title}</button> },
        { key: 'assignee_name', title: 'Who' },
        { key: 'status', title: 'Status', render: (r) => (r.overdue ? <Badge value="overdue" /> : <Badge value={r.status} />) },
        { key: 'checklist', title: 'Checklist', render: (r) => (r.checklist_total ? `${r.checklist_done} of ${r.checklist_total}` : '') },
        { key: 'frequency', title: 'From', render: (r) => (!r.frequency ? 'One-off' : r.frequency === 'need_based' ? 'Routine, raised by hand' : `${label(r.frequency)} routine`) },
        { key: 'completed_at', title: 'Closed', render: (r) => (r.completed_at ? `${dateTime(r.completed_at)}${r.completed_by_name ? ` · ${r.completed_by_name}` : ''}` : '') },
        { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
        { key: 'actions', title: '', render: (r) => (manage && r.status !== 'open'
          ? <ActionButton onClick={() => post(`/ops/tasks/${r.id}/reopen`)} onDone={reload} confirm="Open this task again?">Reopen</ActionButton> : null) },
      ]} />

      {selected && (
        <>
          <h2 className="section">Selected task</h2>
          <TaskCard task={selected} onChange={reload} showAssignee />
          {manage && selected.status === 'open' && (
            <div className="toggle-body">
              <Form key={`${selected.id}${selected.assignee_id}${selected.due_date}`} submit="Save" inline
                initial={{ assignee_id: selected.assignee_id, due_date: selected.due_date }}
                fields={[
                  { name: 'assignee_id', label: 'Give to', type: 'select', required: true, options: people },
                  { name: 'due_date', label: 'Move to', type: 'date', required: true },
                ]}
                onSubmit={(v) => patch(`/ops/tasks/${selected.id}`, v)}
                onDone={reload} />
            </div>
          )}
        </>
      )}
    </Page>
  );
}

export default function TasksPage() {
  return <Suspense><Tasks /></Suspense>;
}
