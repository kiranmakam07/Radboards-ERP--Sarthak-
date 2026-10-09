'use client';

import Link from 'next/link';
import { useState } from 'react';
import { addDays } from '@radcore/shared';
import { plural } from '@/components/charts';
import { InterviewResult } from '@/components/hr';
import { MaintenanceDone, TaskCard, Due, everyText } from '@/components/ops';
import { Card, Loading, Page, Stat, Table, dateTime, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';

/**
 * Everything that is sitting with the person signed in, whatever their role: the tasks given
 * to them, the maintenance they look after, and the interviews they have to take.
 */
export default function MyWorkPage() {
  const work = useGet<{ data: { today: string; tasks: any[]; maintenance: any[] } }>('/ops/my-tasks');
  const interviews = useGet<{ data: any[] }>('/hr/interviews/mine');
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const d = work.data?.data;
  const open = (d?.tasks ?? []).filter((t) => t.status === 'open');
  const late = open.filter((t) => t.overdue);
  const today = open.filter((t) => !t.overdue && t.due_date === d?.today);
  const weekEnd = d ? addDays(d.today, 7) : '';
  const ahead = open.filter((t) => !t.overdue && t.due_date !== d?.today && t.due_date <= weekEnd);
  const later = open.filter((t) => !t.overdue && t.due_date > weekEnd);
  const closed = (d?.tasks ?? []).filter((t) => t.status !== 'open');

  return (
    <Page title="My work">
      <Loading loading={work.loading && !d} error={work.error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="To do today" value={today.length} hint={closed.length ? `${closed.length} already closed today` : undefined} />
            <Stat label="Late" value={late.length ? <span style={{ color: 'var(--danger)' }}>{late.length}</span> : 0} />
            <Stat label="Coming up this week" value={ahead.length} hint={later.length ? `${later.length} more after that` : undefined} />
            <Stat label="Maintenance due" value={d.maintenance.length} />
            <Stat label="Interviews to take" value={interviews.data?.data.length ?? 0} />
          </div>

          {open.length === 0 && closed.length === 0 && d.maintenance.length === 0 ? <p className="muted">Nothing is waiting for you.</p> : null}
          {late.length > 0 && <h2 className="section">Late</h2>}
          {late.map((t) => <TaskCard key={t.id} task={t} onChange={work.reload} />)}
          {today.length > 0 && <h2 className="section">Today</h2>}
          {today.map((t) => <TaskCard key={t.id} task={t} onChange={work.reload} />)}
          {ahead.length > 0 && <h2 className="section">Coming up this week</h2>}
          {ahead.map((t) => <TaskCard key={t.id} task={t} onChange={work.reload} />)}
          {later.length > 0 && <h2 className="section">Later</h2>}
          {later.map((t) => <TaskCard key={t.id} task={t} onChange={work.reload} />)}
          {closed.length > 0 && <h2 className="section">Closed today ({plural(closed.length, 'task')})</h2>}
          {closed.map((t) => <TaskCard key={t.id} task={t} onChange={work.reload} />)}

          {d.maintenance.length > 0 && (
            <Card title="Maintenance I look after">
              <Table rows={d.maintenance} columns={[
                { key: 'asset_name', title: 'Asset', render: (r) => <Link href={`/ops/assets/${r.asset_id}`}>{r.asset_name}</Link> },
                { key: 'title', title: 'Work' },
                { key: 'interval', title: 'How often', render: (r) => everyText(r) },
                { key: 'state', title: 'Due', render: (r) => <Due schedule={r} /> },
                { key: 'instructions', title: 'Instructions', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.instructions}</span> },
                { key: 'actions', title: '', render: (r) => <button type="button" onClick={() => setDoneFor(doneFor === r.id ? null : r.id)}>Mark done</button> },
              ]} />
              {doneFor ? <div className="toggle-body"><MaintenanceDone scheduleId={doneFor} onDone={() => { setDoneFor(null); work.reload(); }} /></div> : null}
            </Card>
          )}
        </>
      )}

      {(interviews.data?.data.length ?? 0) > 0 && (
        <Card title="Interviews I am taking">
          <Table rows={interviews.data?.data} columns={[
            { key: 'applicant_name', title: 'Applicant', render: (r) => <>{r.applicant_name} <span className="muted small">{r.applicant_no}</span></> },
            { key: 'opening_title', title: 'For', render: (r) => r.opening_title ?? 'General application' },
            { key: 'title', title: 'Round', render: (r) => `${r.round}. ${r.title}` },
            { key: 'scheduled_at', title: 'When', render: (r) => dateTime(r.scheduled_at) },
            { key: 'mode', title: 'How', render: (r) => label(r.mode) },
            { key: 'experience_years', title: 'Experience', render: (r) => (r.experience_years !== null ? `${num(r.experience_years)} yrs` : '') },
            { key: 'resume_url', title: 'Resume', render: (r) => (r.resume_url ? <a href={r.resume_url} target="_blank" rel="noreferrer">Open</a> : '') },
            { key: 'actions', title: '', render: (r) => <button type="button" onClick={() => setResultFor(resultFor === r.id ? null : r.id)}>Record result</button> },
          ]} />
          {resultFor ? <div className="toggle-body"><InterviewResult interviewId={resultFor} onDone={() => { setResultFor(null); interviews.reload(); }} /></div> : null}
        </Card>
      )}
    </Page>
  );
}
