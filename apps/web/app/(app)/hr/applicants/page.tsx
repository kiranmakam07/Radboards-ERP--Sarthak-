'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { APPLICANT_SOURCES, APPLICANT_STAGES, APPLICANT_STAGE_LABELS } from '@radcore/shared';
import { Badge, CsvLink, Form, Loading, Page, Table, Toggle, date, dateTime, label, num } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

function Applicants() {
  const params = useSearchParams();
  const can = useCan();
  const [f, setF] = useState({ q: '', stage: params.get('stage') ?? '', opening_id: params.get('opening_id') ?? '', source: '', view: params.get('view') ?? '' });
  const openings = useGet<{ data: any[] }>('/hr/openings');
  const path = `/hr/applicants${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const open = (openings.data?.data ?? []).filter((o) => o.status === 'open');

  return (
    <Page title="Applicants" actions={<><Link className="button" href="/hr/pipeline">Board view</Link><CsvLink href={path} /></>}>
      {can('hr:write') && (
        <Toggle label="+ Add applicant">
          <Form submit="Save applicant"
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'phone', label: 'Phone', type: 'tel', required: true },
              { name: 'email', label: 'Email', type: 'email' },
              { name: 'opening_id', label: 'Applying for', type: 'select', help: 'Blank = general application', options: open.map((o) => ({ value: o.id, label: `${o.title} (${o.department})` })) },
              { name: 'source', label: 'Came through', type: 'select', required: true, options: APPLICANT_SOURCES.map((s) => ({ value: s, label: label(s) })) },
              { name: 'source_detail', label: 'Portal / referred by' },
              { name: 'experience_years', label: 'Experience (years)', type: 'number', step: '0.5' },
              { name: 'current_company', label: 'Current company' },
              { name: 'expected_salary', label: 'Expected salary (per month)', type: 'number' },
              { name: 'resume_url', label: 'Resume link', placeholder: 'https://…', help: 'Drive / Dropbox link to the resume' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onSubmit={(v) => post('/hr/applicants', v)}
            onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        <button type="button" className={f.view === '' && f.stage === '' ? 'primary' : undefined} onClick={() => setF({ ...f, view: '', stage: '' })}>Everyone</button>
        <button type="button" className={f.view === 'open' ? 'primary' : undefined} onClick={() => setF({ ...f, view: 'open', stage: '' })}>In progress</button>
        {(['hired', 'rejected'] as const).map((s) => (
          <button key={s} type="button" className={f.stage === s ? 'primary' : undefined} onClick={() => setF({ ...f, view: '', stage: s })}>{APPLICANT_STAGE_LABELS[s]}</button>
        ))}
      </div>
      <div className="filters">
        <input placeholder="Search name, phone, number" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value, view: '' })}>
          <option value="">Any stage</option>{APPLICANT_STAGES.map((s) => <option key={s} value={s}>{APPLICANT_STAGE_LABELS[s]}</option>)}
        </select>
        <select value={f.opening_id} onChange={(e) => set('opening_id', e.target.value)}>
          <option value="">Any opening</option>{(openings.data?.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
        <select value={f.source} onChange={(e) => set('source', e.target.value)}>
          <option value="">Any source</option>{APPLICANT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No applicants match." rowHref={(r) => `/hr/applicants/${r.id}`} columns={[
        { key: 'applicant_no', title: 'No.' },
        { key: 'name', title: 'Name' },
        { key: 'phone', title: 'Phone' },
        { key: 'opening_title', title: 'Applying for', render: (r) => r.opening_title ?? <span className="muted">General</span> },
        { key: 'stage', title: 'Stage', render: (r) => <><Badge value={r.stage} />{r.reject_reason ? <span className="muted small"> {label(r.reject_reason)}</span> : null}</> },
        { key: 'source', title: 'Source', render: (r) => <>{label(r.source)}{r.source_detail ? <span className="muted small"> · {r.source_detail}</span> : null}</> },
        { key: 'experience_years', title: 'Exp. (yrs)', align: 'right', render: (r) => num(r.experience_years) },
        { key: 'next_interview_at', title: 'Next interview', render: (r) => dateTime(r.next_interview_at) },
        { key: 'applied_on', title: 'Applied', render: (r) => date(r.applied_on) },
      ]} />
    </Page>
  );
}

export default function ApplicantsPage() {
  return <Suspense><Applicants /></Suspense>;
}
