'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  APPLICANT_STAGE_LABELS, APPLICANT_TRANSITIONS, EMPLOYMENT_TYPES, INTERVIEW_MODES, REJECT_REASONS, type ApplicantStage,
} from '@radcore/shared';
import { Steps } from '@/components/charts';
import { InterviewResult } from '@/components/hr';
import { ActionButton, Badge, Card, Form, KV, Loading, Notice, Page, Table, date, dateTime, inr, label, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const iso = (v: string) => (v ? new Date(v).toISOString() : null);
const FLOW: ApplicantStage[] = ['applied', 'shortlisted', 'interview', 'offered', 'hired'];

export default function ApplicantPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/hr/applicants/${id}`);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const [resultFor, setResultFor] = useState<string | null>(null);
  const a = data?.data;
  if (!a) return <Page title="Applicant"><Loading loading={loading} error={error} /></Page>;

  const write = can('hr:write');
  const stage = a.stage as ApplicantStage;
  // The stage machine is fixed: only offer the moves that are allowed from here. Hiring has its own form.
  const moves = APPLICANT_TRANSITIONS[stage].filter((s) => s !== 'hired');
  const canHire = APPLICANT_TRANSITIONS[stage].includes('hired');
  const canBook = ['applied', 'shortlisted', 'interview'].includes(stage);
  const userOptions = (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));

  return (
    <Page title={`${a.applicant_no} · ${a.name}`} actions={
      <>
        <a className="button" href={`tel:${a.phone}`}>Call</a>
        {a.resume_url ? <a className="button" target="_blank" rel="noreferrer" href={a.resume_url}>Open resume</a> : null}
      </>
    }>
      <Steps steps={FLOW.map((s) => APPLICANT_STAGE_LABELS[s])}
        current={stage === 'hired' ? FLOW.length : FLOW.indexOf(stage)}
        stopped={stage === 'rejected' ? `Rejected: ${label(a.reject_reason)}` : null} />
      {a.employee_id ? <Notice>Hired as <Link href={`/hr/employees/${a.employee_id}`}>{a.employee_name} ({a.employee_no})</Link>.</Notice> : null}
      <Card>
        <KV rows={[
          ['Stage', <Badge key="s" value={a.stage} />],
          ['Applying for', a.opening_title ?? 'General application'],
          ['Phone', a.phone], ['Email', a.email],
          ['Came through', `${label(a.source)}${a.source_detail ? ` · ${a.source_detail}` : ''}`],
          ['Experience', a.experience_years !== null ? `${num(a.experience_years)} years` : null],
          ['Current company', a.current_company],
          ['Expected salary', a.expected_salary ? `₹${inr(a.expected_salary)} per month` : null],
          ['Handled by', a.owner_name],
          ['Applied on', date(a.applied_on)],
          ['Notes', a.notes],
        ]} />
      </Card>

      {write && (moves.length > 0 || canHire) && (
        <div className="grid">
          {canHire && (
            <Card title="Hire">
              <Form submit="Hire and create employee"
                initial={{ department: a.opening_department ?? '', designation: a.opening_title ?? '', employment_type: 'full_time', monthly_salary: a.expected_salary ?? '' }}
                fields={[
                  { name: 'join_date', label: 'Joining date', type: 'date', required: true },
                  { name: 'department', label: 'Department', required: true },
                  { name: 'designation', label: 'Designation', required: true },
                  { name: 'employment_type', label: 'Type', type: 'select', required: true, options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: label(t) })) },
                  { name: 'monthly_salary', label: 'Salary (per month)', type: 'number' },
                ]}
                onSubmit={(v) => post(`/hr/applicants/${id}/hire`, v)}
                onDone={reload} />
            </Card>
          )}

          {canBook && (
            <Card title="Book an interview">
              <Form submit="Book"
                initial={{ mode: 'in_person' }}
                fields={[
                  { name: 'title', label: 'Round', required: true, placeholder: 'e.g. Manager round' },
                  { name: 'scheduled_at', label: 'When', type: 'datetime-local', required: true },
                  { name: 'mode', label: 'How', type: 'select', required: true, options: INTERVIEW_MODES.map((m) => ({ value: m, label: label(m) })) },
                  { name: 'interviewer_id', label: 'Interviewer', type: 'select', options: userOptions, help: 'They will see it under My work' },
                ]}
                onSubmit={(v) => post(`/hr/applicants/${id}/interviews`, { ...v, scheduled_at: iso(v.scheduled_at) })}
                onDone={reload} />
            </Card>
          )}

          {moves.length > 0 && (
            <Card title="Move stage">
              <Form submit="Move"
                fields={[
                  { name: 'stage', label: 'To', type: 'select', required: true, options: moves.map((s) => ({ value: s, label: APPLICANT_STAGE_LABELS[s] })) },
                  { name: 'reject_reason', label: 'Reason', type: 'select', help: 'Needed for Rejected', options: REJECT_REASONS.map((r) => ({ value: r, label: label(r) })) },
                  { name: 'note', label: 'Note', type: 'textarea' },
                ]}
                onSubmit={(v) => post(`/hr/applicants/${id}/stage`, v)}
                onDone={reload} />
            </Card>
          )}

          <Card title="Add a note">
            <Form submit="Save"
              initial={{ type: 'note' }}
              fields={[
                { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }] },
                { name: 'note', label: 'Note', type: 'textarea', required: true },
              ]}
              onSubmit={(v) => post(`/hr/applicants/${id}/activities`, v)}
              onDone={reload} />
          </Card>
        </div>
      )}

      <Card title="Interviews">
        <Table rows={a.interviews} empty="No interview booked yet." columns={[
          { key: 'round', title: 'Round', render: (r) => `${r.round}. ${r.title}` },
          { key: 'scheduled_at', title: 'When', render: (r) => dateTime(r.scheduled_at) },
          { key: 'mode', title: 'How', render: (r) => label(r.mode) },
          { key: 'interviewer_name', title: 'Interviewer' },
          { key: 'status', title: 'Status', render: (r) => (r.result ? <Badge value={r.result} /> : <Badge value={r.status} />) },
          { key: 'rating', title: 'Rating', render: (r) => (r.rating ? `${r.rating}/5` : '') },
          { key: 'feedback', title: 'Feedback', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.feedback}</span> },
          { key: 'actions', title: '', render: (r) => (write && r.status === 'scheduled' ? (
            <>
              <button type="button" onClick={() => setResultFor(resultFor === r.id ? null : r.id)}>Record result</button>{' '}
              <ActionButton onClick={() => post(`/hr/interviews/${r.id}/cancel`, { status: 'no_show' })} onDone={reload} confirm="Mark that the applicant did not turn up?">No show</ActionButton>{' '}
              <ActionButton onClick={() => post(`/hr/interviews/${r.id}/cancel`, { status: 'cancelled' })} onDone={reload} confirm="Cancel this round?">Cancel</ActionButton>
            </>
          ) : null) },
        ]} />
        {resultFor ? <div className="toggle-body"><InterviewResult interviewId={resultFor} onDone={() => { setResultFor(null); reload(); }} /></div> : null}
      </Card>

      {a.earlier_applications.length > 0 && (
        <Card title="Other applications from this person">
          <Table rows={a.earlier_applications} rowHref={(r) => `/hr/applicants/${r.id}`} columns={[
            { key: 'applicant_no', title: 'No.' }, { key: 'opening_title', title: 'For', render: (r) => r.opening_title ?? 'General' },
            { key: 'applied_on', title: 'Applied', render: (r) => date(r.applied_on) },
            { key: 'stage', title: 'Outcome', render: (r) => <><Badge value={r.stage} />{r.reject_reason ? <span className="muted small"> {label(r.reject_reason)}</span> : null}</> },
          ]} />
        </Card>
      )}

      <Card title="History">
        <Table rows={a.activities} empty="Nothing yet." columns={[
          { key: 'at', title: 'When', render: (r) => dateTime(r.at) },
          { key: 'type', title: 'Type', render: (r) => label(r.type) },
          { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
          { key: 'user_name', title: 'By', render: (r) => r.user_name ?? 'System' },
        ]} />
      </Card>
    </Page>
  );
}
