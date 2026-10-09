'use client';

import { useState } from 'react';
import { PROJECT_STATUSES, istDate } from '@radcore/shared';
import { Badge, CsvLink, Form, Loading, Page, Table, Toggle, date, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function ProjectsPage() {
  const can = useCan();
  const [f, setF] = useState({ view: 'live', status: '' });
  const path = `/ops/projects${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const users = useGet<{ data: any[] }>('/masters/users-lite');

  return (
    <Page title="Projects" actions={<CsvLink href={path} />}>
      <p className="muted">Work with a start, an end and several people: a store launch, an exhibition, a new product. Each project holds its tasks, each with a person and a deadline.</p>
      {can('ops:manage') && (
        <Toggle label="+ New project">
          <Form submit="Create project"
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
        </Toggle>
      )}
      <div className="filters">
        <button type="button" className={f.view === 'live' ? 'primary' : undefined} onClick={() => setF({ view: 'live', status: '' })}>Running</button>
        <button type="button" className={f.view === '' && f.status === '' ? 'primary' : undefined} onClick={() => setF({ view: '', status: '' })}>All</button>
        <select value={f.status} onChange={(e) => setF({ view: '', status: e.target.value })}>
          <option value="">Any status</option>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No projects here." rowHref={(r) => `/ops/projects/${r.id}`} columns={[
        { key: 'project_no', title: 'No.' },
        { key: 'name', title: 'Project' },
        { key: 'owner_name', title: 'Responsible' },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'progress', title: 'Progress', render: (r) => (r.tasks ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="progress" aria-hidden="true"><span style={{ width: `${Math.round((r.tasks_done / r.tasks) * 100)}%` }} /></span>
            <span className="small">{r.tasks_done} of {r.tasks} tasks</span>
          </span>
        ) : <span className="muted small">No tasks yet</span>) },
        { key: 'tasks_late', title: 'Late tasks', align: 'right', render: (r) => (r.tasks_late ? <span className="error small">{r.tasks_late}</span> : 0) },
        { key: 'people', title: 'People', align: 'right' },
        { key: 'deadline', title: 'Deadline', render: (r) => (!r.deadline ? '' : (
          <span className={r.overdue ? 'error small' : undefined}>
            {date(r.deadline)}{r.status === 'done' || r.status === 'cancelled' ? '' : r.days_left < 0 ? ` · ${-r.days_left} days over` : ` · ${r.days_left} days left`}
          </span>
        )) },
      ]} />
    </Page>
  );
}
