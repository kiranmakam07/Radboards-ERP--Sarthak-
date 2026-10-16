'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, istDate, type ProjectStatus } from '@radcore/shared';
import { Board } from '@/components/board';
import { Badge, CsvLink, ErrorBox, FormModal, Loading, Modal, Page, Table, ViewSwitch, date, label, useRemembered } from '@/components/ui';
import { patch, post, qs, useGet } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

const MODES = ['board', 'list'] as const;
const LIVE: ProjectStatus[] = ['planned', 'active', 'on_hold'];
const COLUMNS = PROJECT_STATUSES.map((key) => ({ key, title: PROJECT_STATUS_LABELS[key] }));

/** A project's progress: a thin bar and "3 of 5 tasks". */
function Progress({ p }: { p: any }) {
  if (!p.tasks) return <span className="muted small">No tasks yet</span>;
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span className="progress" aria-hidden="true"><span style={{ width: `${Math.round((p.tasks_done / p.tasks) * 100)}%` }} /></span>
      <span className="small">{p.tasks_done} of {p.tasks} tasks</span>
    </span>
  );
}

/** "12-11-2026 · 4 days left", in red once it is over. */
function Deadline({ p }: { p: any }) {
  if (!p.deadline) return null;
  return (
    <span className={p.overdue ? 'error small' : undefined}>
      {date(p.deadline)}{p.status === 'done' || p.status === 'cancelled' ? '' : p.days_left < 0 ? ` · ${-p.days_left} days over` : ` · ${p.days_left} days left`}
    </span>
  );
}

type Asking = { project: any; to: ProjectStatus };

/**
 * Projects by status: drag a card from Planned to Active, On hold, Done or Cancelled. Done and
 * Cancelled ask first in a pop-up (and Done says so when tasks are still open, which the API
 * would refuse); taking a finished project back asks too. Clicking a card opens the project.
 */
function ProjectBoard({ projects, onChange }: { projects: any[]; onChange: () => void }) {
  const router = useRouter();
  const { user } = useSession();
  const manage = useCan()('ops:manage');
  const [moving, setMoving] = useState<Record<string, ProjectStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  useEffect(() => { setMoving({}); }, [projects]);

  async function go(p: any, to: ProjectStatus) {
    setError(null);
    setMoving((m) => ({ ...m, [p.id]: to }));
    try {
      await patch(`/ops/projects/${p.id}`, { status: to });
      onChange();
    } catch (e) {
      setMoving((m) => {
        const { [p.id]: _gone, ...rest } = m;
        return rest;
      });
      setError(`${p.name}: ${(e as Error).message}`);
    }
  }

  function move(p: any, to: string) {
    const status = to as ProjectStatus;
    const closing = status === 'done' || status === 'cancelled';
    const reopening = !LIVE.includes(p.status) && LIVE.includes(status);
    if (closing || reopening) setAsking({ project: p, to: status });
    else void go(p, status);
  }

  const a = asking;
  return (
    <>
      <ErrorBox error={error} />
      <Board columns={COLUMNS} items={projects} keyOf={(p) => p.id} columnOf={(p) => moving[p.id] ?? p.status}
        canMove={(p) => manage || p.owner_id === user.id} onMove={move} onOpen={(p) => router.push(`/ops/projects/${p.id}`)}
        emptyColumn="No projects"
        render={(p) => (
          <>
            <div className="title">{p.name}</div>
            <div className="meta"><span>{p.project_no}</span><span>{p.owner_name}</span>{p.tasks_late ? <span className="late">{p.tasks_late} late</span> : null}</div>
            <div className="meta"><Progress p={p} /></div>
            {p.deadline ? <div className="meta"><Deadline p={p} /></div> : null}
          </>
        )} />

      {a ? (
        <Modal title={`${a.project.name}: ${PROJECT_STATUS_LABELS[a.to]}?`} onClose={() => setAsking(null)}>
          {a.to === 'done' && a.project.tasks_open > 0 ? (
            <>
              <p>{a.project.tasks_open} task{a.project.tasks_open === 1 ? ' is' : 's are'} still open. A project is done once every task is
                finished or marked as not done.</p>
              <div className="form-foot">
                <Link className="button primary" href={`/ops/projects/${a.project.id}`}>Open the project</Link>
                <button type="button" onClick={() => setAsking(null)}>Not now</button>
              </div>
            </>
          ) : (
            <>
              <p>{a.to === 'done' ? 'It is marked as finished today, and the people and machines on it are freed from today.'
                : a.to === 'cancelled' ? 'Its open tasks are closed as not done, and the people and machines on it are freed from today.'
                : `It goes back to ${PROJECT_STATUS_LABELS[a.to]}.`}</p>
              <div className="form-foot">
                <button type="button" className={a.to === 'cancelled' ? 'danger' : 'primary'} onClick={() => { setAsking(null); void go(a.project, a.to); }}>
                  {a.to === 'done' ? 'Mark done' : a.to === 'cancelled' ? 'Cancel the project' : 'Reopen it'}
                </button>
                <button type="button" onClick={() => setAsking(null)}>Leave it</button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

export default function ProjectsPage() {
  const can = useCan();
  const [mode, setMode] = useRemembered('radcore-view:/ops/projects', MODES, 'board');
  const [f, setF] = useState({ view: 'live', status: '' });
  const [adding, setAdding] = useState(false);
  // The board shows every status as a column; the list is filtered.
  const path = mode === 'board' ? '/ops/projects' : `/ops/projects${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const users = useGet<{ data: any[] }>('/masters/users-lite');

  return (
    <Page title="Projects" actions={
      <>
        {can('ops:manage') ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ New project</button> : null}
        <ViewSwitch value={mode} onChange={setMode}
          options={[{ value: 'board', label: 'Board', icon: 'board' }, { value: 'list', label: 'List', icon: 'table' }]} />
        <CsvLink href={path} />
      </>
    }>
      <p className="muted">Work with a start, an end and several people: a store launch, an exhibition, a new product. Each project holds its tasks, each with a person and a deadline.</p>
      {mode === 'list' ? (
        <div className="filters">
          <button type="button" className={f.view === 'live' ? 'primary' : undefined} onClick={() => setF({ view: 'live', status: '' })}>Running</button>
          <button type="button" className={f.view === '' && f.status === '' ? 'primary' : undefined} onClick={() => setF({ view: '', status: '' })}>All</button>
          <select value={f.status} onChange={(e) => setF({ view: '', status: e.target.value })}>
            <option value="">Any status</option>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
      ) : <p className="muted small">Drag a card to another column to change its status (on a phone, hold it for a moment first). Tap or click a card to open the project.</p>}
      <Loading loading={loading} error={error} />

      {mode === 'board' && data ? <ProjectBoard projects={data.data} onChange={reload} /> : null}

      {mode === 'list' ? (
        <Table rows={data?.data} empty="No projects here." rowHref={(r) => `/ops/projects/${r.id}`} columns={[
          { key: 'project_no', title: 'No.' },
          { key: 'name', title: 'Project' },
          { key: 'owner_name', title: 'Responsible' },
          { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'progress', title: 'Progress', render: (r) => <Progress p={r} /> },
          { key: 'tasks_late', title: 'Late tasks', align: 'right', render: (r) => (r.tasks_late ? <span className="error small">{r.tasks_late}</span> : 0) },
          { key: 'people', title: 'People', align: 'right' },
          { key: 'deadline', title: 'Deadline', render: (r) => <Deadline p={r} /> },
        ]} />
      ) : null}

      {adding ? (
        <FormModal title="New project" submit="Create project" onClose={() => setAdding(false)}
          initial={{ start_date: istDate() }}
          fields={[
            { name: 'name', label: 'Project', required: true },
            { name: 'owner_id', label: 'Who is responsible', type: 'select', required: true, options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
            { name: 'start_date', label: 'Starts', type: 'date', required: true },
            { name: 'deadline', label: 'Deadline', type: 'date' },
            { name: 'description', label: 'What it is for', type: 'textarea' },
          ]}
          onSubmit={(v) => post('/ops/projects', v)}
          onDone={reload} />
      ) : null}
    </Page>
  );
}
