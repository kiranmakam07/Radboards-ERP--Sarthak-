'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { addDays, istDate } from '@radcore/shared';
import { ChartCard, Steps, Timeline, type TimelineRow } from '@/components/charts';
import { TaskBoard, TaskModal, checklistLines, deadlineText, taskFields } from '@/components/ops';
import { ActionButton, Badge, Card, Form, FormModal, KV, Loading, Page, Stat, Table, ViewSwitch, date, label, useRemembered } from '@/components/ui';
import { ApiError, api, patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const MODES = ['board', 'list'] as const;

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/ops/projects/${id}`);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  // Allocating people is an operations job; a project owner from another team simply does not see that form.
  const allocate = can('ops:manage');
  const people = useGet<{ data: any[] }>(allocate ? '/ops/people' : null);
  const machines = useGet<{ data: any[] }>(allocate ? '/ops/assets' : null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useRemembered('radcore-view:/ops/projects/[id]', MODES, 'board');
  const p = data?.data;
  if (!p) return <Page title="Project"><Loading loading={loading} error={error} /></Page>;

  const today = istDate();
  const manage = p.can_manage as boolean;
  const live = ['planned', 'active', 'on_hold'].includes(p.status);
  const tasks: any[] = p.tasks;
  const counted = tasks.filter((t) => t.status !== 'skipped');
  const done = counted.filter((t) => t.status === 'done').length;
  const late = tasks.filter((t) => t.overdue).length;
  const selected = tasks.find((t) => t.id === openId);
  const setStatus = (status: string) => patch(`/ops/projects/${id}`, { status });
  const userOptions = (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));

  // The plan runs from the project's start to its deadline, or to the last task when there is no deadline.
  const lastDay = tasks.reduce((m, t) => (t.due_date > m ? t.due_date : m), p.deadline ?? addDays(p.start_date, 14));
  const timeline: TimelineRow[] = tasks.map((t) => ({
    label: t.title, from: t.start_date, to: t.due_date, note: `${t.assignee_name}, ${deadlineText(t)}`,
    state: t.status === 'done' ? 'done' : t.status === 'skipped' ? 'skipped' : t.overdue ? 'late' : 'open',
  }));

  /** Allocate, and if the person or machine is already fully committed, ask before going over. */
  async function addAllocation(v: Record<string, any>) {
    const body = { ...v, project_id: id, employee_id: v.kind === 'asset' ? '' : v.employee_id, asset_id: v.kind === 'asset' ? v.asset_id : '' };
    try {
      return await post('/ops/allocations', body);
    } catch (e) {
      const err = e as ApiError;
      const clashes = (err.details as { clashes?: { work: string; percent: number }[] } | undefined)?.clashes;
      if (err.status !== 409 || !clashes) throw e;
      const list = clashes.map((c) => `${c.work} (${c.percent}%)`).join(', ');
      if (!window.confirm(`${err.message}. Already on: ${list}. Allocate anyway?`)) throw e;
      return post('/ops/allocations', { ...body, allow_over: true });
    }
  }

  return (
    <Page title={`${p.project_no} · ${p.name}`} actions={manage ? (
      <>
        {p.status === 'planned' && <ActionButton onClick={() => setStatus('active')} onDone={reload}>Start</ActionButton>}
        {p.status === 'active' && <ActionButton onClick={() => setStatus('on_hold')} onDone={reload}>Put on hold</ActionButton>}
        {p.status === 'on_hold' && <ActionButton onClick={() => setStatus('active')} onDone={reload}>Resume</ActionButton>}
        {live && <ActionButton kind="primary" onClick={() => setStatus('done')} onDone={reload}>Mark done</ActionButton>}
        {live && <ActionButton kind="danger" onClick={() => setStatus('cancelled')} onDone={reload} confirm="Cancel this project? Its open tasks will be closed as not done and its people freed from today.">Cancel</ActionButton>}
        {!live && <ActionButton onClick={() => setStatus('active')} onDone={reload}>Reopen</ActionButton>}
      </>
    ) : null}>
      <Steps steps={['Planned', 'Active', 'Done']}
        current={p.status === 'done' ? 3 : p.status === 'planned' ? 0 : 1}
        stopped={p.status === 'cancelled' ? 'Cancelled' : p.status === 'on_hold' ? 'On hold' : null} />

      <div className="stats">
        <Stat label="Tasks done" value={`${done} of ${counted.length}`} hint={counted.length ? `${Math.round((done / counted.length) * 100)}% complete` : 'No tasks yet'} />
        <Stat label="Late tasks" value={late ? <span style={{ color: 'var(--danger)' }}>{late}</span> : 0} />
        <Stat label="Deadline" value={p.deadline ? date(p.deadline) : 'Not set'}
          hint={!p.deadline || !live ? undefined : p.days_left < 0 ? <span className="error small">{-p.days_left} days over</span> : `${p.days_left} days left`} />
        <Stat label="People on it" value={new Set(p.allocations.filter((a: any) => a.employee_id).map((a: any) => a.employee_id)).size} />
      </div>

      <Card>
        <KV rows={[
          ['Status', <Badge key="s" value={p.status} />],
          ['Responsible', p.owner_name],
          ['Starts', date(p.start_date)],
          ['Finished on', date(p.completed_on)],
          ['What it is for', p.description],
        ]} />
      </Card>

      <ChartCard title={`The plan, ${date(p.start_date)} to ${date(lastDay)}`}>
        <Timeline rows={timeline} from={p.start_date} to={lastDay} today={today} empty="No tasks yet. Add the first one below." />
        <p className="muted small" style={{ marginTop: 8 }}>A bar runs from a task's start to its deadline; a dot marks a deadline with no start date. Grey is finished, red is late.</p>
      </ChartCard>

      <Card title="Tasks" actions={
        <>
          {manage && live ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ Add a task</button> : null}
          <ViewSwitch value={mode} onChange={setMode}
            options={[{ value: 'board', label: 'Board', icon: 'board' }, { value: 'list', label: 'List', icon: 'table' }]} />
        </>
      }>
        {mode === 'board' ? (
          tasks.length ? <TaskBoard tasks={tasks} onChange={reload} people={userOptions} showProject={false} recentOnly={false} />
            : <p className="muted">No tasks yet.{manage && live ? ' Add the first one with + Add a task.' : ''}</p>
        ) : <Table rows={tasks} empty="No tasks yet." columns={[
          { key: 'title', title: 'Task', render: (r) => <button type="button" className="link" onClick={() => setOpenId(r.id)}>{r.title}</button> },
          { key: 'assignee_name', title: 'Who' },
          { key: 'start_date', title: 'Starts', render: (r) => date(r.start_date) },
          { key: 'due_date', title: 'Deadline', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{deadlineText(r)}</span> },
          { key: 'status', title: 'Status', render: (r) => (r.overdue ? <Badge value="overdue" /> : <Badge value={r.status} />) },
          { key: 'checklist', title: 'Checklist', render: (r) => (r.checklist_total ? `${r.checklist_done} of ${r.checklist_total}` : '') },
          { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
        ]} />}
      </Card>
      {selected ? <TaskModal task={selected} people={userOptions} onChange={reload} onClose={() => setOpenId(null)} /> : null}

      {adding ? (
        <FormModal title={`New task in ${p.name}`} submit="Add task" onClose={() => setAdding(false)}
          intro={p.deadline ? <p className="muted small">The project's deadline is {date(p.deadline)}; a task's deadline cannot be later.</p> : null}
          fields={taskFields(userOptions, true)}
          onSubmit={({ checklist, ...v }) => post(`/ops/projects/${id}/tasks`, { ...v, checklist: checklistLines(checklist) })}
          onDone={reload} />
      ) : null}

      <Card title="People and machines on this project" actions={<Link href="/ops/resources">Resource allocation</Link>}>
        <Table rows={p.allocations} empty="Nobody allocated yet." columns={[
          { key: 'resource_name', title: 'Who / what', render: (r) => <>{r.resource_name}{r.asset_id ? <span className="muted small"> · machine</span> : null}</> },
          { key: 'role', title: 'Doing' },
          { key: 'percent', title: 'Share of their time', align: 'right', render: (r) => `${r.percent}%` },
          { key: 'from_date', title: 'From', render: (r) => date(r.from_date) },
          { key: 'to_date', title: 'To', render: (r) => date(r.to_date) },
          { key: 'actions', title: '', render: (r) => (allocate && live
            ? <ActionButton onClick={() => api(`/ops/allocations/${r.id}`, { method: 'DELETE' })} onDone={reload} confirm={`Take ${r.resource_name} off this project?`}>Remove</ActionButton> : null) },
        ]} />
        {allocate && live && (
          <div className="toggle-body" style={{ marginTop: 12 }}>
            <Form submit="Allocate"
              initial={{ kind: 'person', percent: 100, from_date: p.start_date > today ? p.start_date : today, to_date: p.deadline ?? '' }}
              fields={[
                { name: 'kind', label: 'Allocate a', type: 'select', required: true, options: [{ value: 'person', label: 'Person' }, { value: 'asset', label: 'Machine or vehicle' }] },
                { name: 'employee_id', label: 'Person', type: 'select', options: (people.data?.data ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.department})` })) },
                { name: 'asset_id', label: 'Machine or vehicle', type: 'select', options: (machines.data?.data ?? []).filter((a) => a.status !== 'retired').map((a) => ({ value: a.id, label: `${a.name} (${label(a.category)})` })) },
                { name: 'from_date', label: 'From', type: 'date', required: true },
                { name: 'to_date', label: 'To', type: 'date', required: true },
                { name: 'percent', label: 'Share of their time (%)', type: 'number', step: '5', required: true },
                { name: 'role', label: 'Doing what' },
              ]}
              onSubmit={addAllocation}
              onDone={reload} />
          </div>
        )}
      </Card>
    </Page>
  );
}
