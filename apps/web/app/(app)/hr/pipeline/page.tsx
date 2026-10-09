'use client';

import Link from 'next/link';
import { useState } from 'react';
import { APPLICANT_STAGE_LABELS, type ApplicantStage } from '@radcore/shared';
import { plural } from '@/components/charts';
import { Loading, Page, dateTime, num } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

/** Everyone still in the running, by stage. The stage is changed on the applicant's own page. */
export default function HiringBoard() {
  const [openingId, setOpeningId] = useState('');
  const openings = useGet<{ data: any[] }>('/hr/openings');
  const { data, loading, error } = useGet<{ data: any[]; stages: ApplicantStage[] }>(`/hr/applicants/pipeline${qs({ opening_id: openingId })}`);
  return (
    <Page title="Hiring board" actions={
      <>
        <select value={openingId} onChange={(e) => setOpeningId(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All openings</option>
          {(openings.data?.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
        <Link className="button" href="/hr/applicants">List view</Link>
      </>
    }>
      <Loading loading={loading} error={error} />
      {data && (
        <div className="kanban">
          {data.stages.map((stage) => {
            const people = data.data.filter((a) => a.stage === stage);
            return (
              <div className="col" key={stage}>
                <h2><span>{APPLICANT_STAGE_LABELS[stage]} ({people.length})</span></h2>
                {people.map((a) => (
                  <Link key={a.id} href={`/hr/applicants/${a.id}`} className="lead">
                    <strong>{a.name}</strong> <span className="muted small">{a.applicant_no}</span><br />
                    <span className="small">{a.opening_title ?? 'General application'}</span><br />
                    <span className="small muted">
                      {a.experience_years !== null ? `${num(a.experience_years)} yrs · ` : ''}
                      {a.next_interview_at ? `Interview ${dateTime(a.next_interview_at)}` : `${plural(a.days_open, 'day')} since applying`}
                    </span>
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
