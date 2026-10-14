'use client';

import Link from 'next/link';
import { useState } from 'react';
import { addDays } from '@radcore/shared';
import { plural } from '@/components/charts';
import { InterviewResult, MyAttendance } from '@/components/hr';
import { MaintenanceDone, TaskCard, Due, everyText } from '@/components/ops';
import { Card, Loading, Page, Stat, Table, dateTime, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * Everything that is sitting with the person signed in, whatever their role: the tasks given
 * to them, the maintenance they look after, and the interviews they have to take.
 */
export default function MyWorkPage() {
  const work = useGet<{ data: { today: string; tasks: any[]; maintenance: any[] } }>('/ops/my-tasks');
  const interviews = useGet<{ data: any[] }>('/hr/interviews/mine');
  const can = useCan();
  const sells = can('leads:write');
  const fresh = useGet<{ data: any[] }>(sells ? '/leads?mine=true&stage=new&limit=50' : null);
  const followUps = useGet<{ data: any[] }>(sells ? '/leads?mine=true&view=followups_due&limit=50' : null);
  // A lead can be in both lists; show it once, new ones first.
  const myLeads = [...(fresh.data?.data ?? []), ...(followUps.data?.data ?? []).filter((l) => l.stage !== 'new')];
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
      <MyAttendance />
      <Loading loading={work.loading && !d} error={work.error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="To do today" value={today.length} hint={closed.length ? `${closed.length} already closed today` : undefined} />
            <Stat label="Late" value={late.length ? <span style={{ color: 'var(--danger)' }}>{late.length}</span> : 0} />
            <Stat label="Coming up this week" value={ahead.length} hint={later.length ? `${later.length} more after that` : undefined} />
            <Stat label="Maintenance due" value={d.maintenance.length} />
            <Stat label="Interviews to take" value={interviews.data?.data.length ?? 0} />
            {sells ? <Stat label="Leads waiting for me" value={myLeads.length} hint="new, or follow-up due" /> : null}
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
                { key: 'asset_name', title: 'Asset', render: (r) => (can('ops:read') ? <Link href={`/ops/assets/${r.asset_id}`}>{r.asset_name}</Link> : r.asset_name) },
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

      {myLeads.length > 0 && (
        <Card title="Leads waiting for me" actions={<Link href="/leads?mine=true">All my leads</Link>}>
          <Table rows={myLeads} rowHref={(r) => `/leads/${r.id}`} columns={[
            { key: 'name', title: 'Lead', render: (r) => <>{r.name} <span className="muted small">{r.lead_no}</span></> },
            { key: 'phone', title: 'Phone' },
            { key: 'source_name', title: 'From', render: (r) => <>{r.source_name}{r.source_detail ? <span className="muted small"> · {r.source_detail}</span> : null}</> },
            { key: 'stage', title: 'Stage', render: (r) => label(r.stage) },
            { key: 'next_follow_up_at', title: 'Follow up by', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{dateTime(r.next_follow_up_at)}</span> },
          ]} />
        </Card>
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
