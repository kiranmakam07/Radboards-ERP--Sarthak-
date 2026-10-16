'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { TASK_STATUSES, istDate } from '@radcore/shared';
import { TaskBoard, TaskModal, checklistLines, deadlineText, taskFields } from '@/components/ops';
import { ActionButton, Badge, CsvLink, FormModal, Loading, Page, Table, ViewSwitch, dateTime, label, useRemembered } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const VIEWS: [string, string][] = [['today', 'Today'], ['overdue', 'Late'], ['', 'All']];
const MODES = ['board', 'list'] as const;

/**
 * Everyone's tasks, as a board (drag a card from To do to In progress to Done) or as a list with
 * filters. A link from elsewhere that asks for a list (?view=overdue from the home screen) opens
 * the list; otherwise the screen opens the way this person last left it.
 */
function Tasks() {
  const params = useSearchParams();
  const can = useCan();
  const manage = can('ops:manage');
  const [mode, setMode] = useRemembered('radcore-view:/ops/tasks', MODES, 'board');
  const [linked, setLinked] = useState(Boolean(params.get('view')));
  const shown = linked ? 'list' : mode;
  const [f, setF] = useState({ view: params.get('view') ?? 'today', status: '', assignee_id: '', q: '' });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const path = shown === 'board'
    ? `/ops/tasks${qs({ view: 'board', assignee_id: f.assignee_id, q: f.q, limit: 1000 })}`
    : `/ops/tasks${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const people = (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));
  const opened = data?.data.find((t) => t.id === openId);

  return (
    <Page title="Tasks" actions={
      <>
        {manage ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ New task</button> : null}
        <ViewSwitch value={shown} onChange={(v) => { setLinked(false); setMode(v); }}
          options={[{ value: 'board', label: 'Board', icon: 'board' }, { value: 'list', label: 'List', icon: 'table' }]} />
        <CsvLink href={path} />
      </>
    }>
      <div className="filters">
        {shown === 'list' && VIEWS.map(([v, l]) => (
          <button key={v} type="button" className={f.view === v ? 'primary' : undefined} onClick={() => setF({ ...f, view: v })}>{l}</button>
        ))}
        <input placeholder="Search task" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        {shown === 'list' && (
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Any status</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        )}
        <select value={f.assignee_id} onChange={(e) => setF({ ...f, assignee_id: e.target.value })}>
          <option value="">Anyone</option>{(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />

      {shown === 'board' && data ? (
        <>
          <p className="muted small">Drag a card to another column to move it (on a phone, hold it for a moment first). Tap or click a card to open it.</p>
          <TaskBoard tasks={data.data} onChange={reload} people={people} />
        </>
      ) : null}

      {shown === 'list' ? (
        <Table rows={data?.data} empty="No tasks here." columns={[
          { key: 'due_date', title: 'Deadline', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{deadlineText(r)}</span> },
          { key: 'title', title: 'Task', render: (r) => <button type="button" className="link" onClick={() => setOpenId(r.id)}>{r.title}</button> },
          { key: 'assignee_name', title: 'Who' },
          { key: 'status', title: 'Status', render: (r) => (r.overdue ? <Badge value="overdue" /> : <Badge value={r.stage === 'in_progress' ? 'in_progress' : r.status} />) },
          { key: 'checklist', title: 'Checklist', render: (r) => (r.checklist_total ? `${r.checklist_done} of ${r.checklist_total}` : '') },
          { key: 'frequency', title: 'From', render: (r) => (r.project_id ? <Link href={`/ops/projects/${r.project_id}`}>{r.project_no} · {r.project_name}</Link>
            : !r.frequency ? 'One-off' : r.frequency === 'need_based' ? 'Routine, raised by hand' : `${label(r.frequency)} routine`) },
          { key: 'completed_at', title: 'Closed', render: (r) => (r.completed_at ? `${dateTime(r.completed_at)}${r.completed_by_name ? ` · ${r.completed_by_name}` : ''}` : '') },
          { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
          { key: 'actions', title: '', render: (r) => (manage && r.status !== 'open'
            ? <ActionButton onClick={() => post(`/ops/tasks/${r.id}/reopen`)} onDone={reload} confirm="Open this task again?">Reopen</ActionButton> : null) },
        ]} />
      ) : null}

      {opened ? <TaskModal task={opened} people={people} onChange={reload} onClose={() => setOpenId(null)} /> : null}

      {adding ? (
        <FormModal title="New task" submit="Give task" onClose={() => setAdding(false)}
          intro={<p className="muted small">For work that repeats, set up a routine instead: its tasks then appear by themselves.</p>}
          initial={{ due_date: istDate() }}
          fields={taskFields(people)}
          onSubmit={({ checklist, ...v }) => post('/ops/tasks', { ...v, checklist: checklistLines(checklist) })}
          onDone={reload} />
      ) : null}
    </Page>
  );
}

export default function TasksPage() {
  return <Suspense><Tasks /></Suspense>;
}
