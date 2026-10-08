'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LEAD_STAGE_LABELS, type LeadStage } from '@radcore/shared';
import { Loading, Page, dateTime, inr } from '@/components/ui';
import { useGet } from '@/lib/api';

export default function PipelinePage() {
  const [mine, setMine] = useState(false);
  const { data, loading, error } = useGet<{ data: any[]; stages: LeadStage[] }>(`/leads/pipeline${mine ? '?mine=true' : ''}`);
  return (
    <Page title="Pipeline" actions={
      <>
        <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only</label>
        <Link className="button" href="/leads">List view</Link>
      </>
    }>
      <Loading loading={loading} error={error} />
      {data && (
        <div className="kanban">
          {data.stages.map((stage) => {
            const leads = data.data.filter((l) => l.stage === stage);
            const value = leads.reduce((s, l) => s + Number(l.value), 0);
            return (
              <div className="col" key={stage}>
                <h2><span>{LEAD_STAGE_LABELS[stage]} ({leads.length})</span><span className="muted small">₹{inr(value)}</span></h2>
                {leads.map((l) => (
                  <Link key={l.id} href={`/leads/${l.id}`} className={l.overdue ? 'lead overdue' : 'lead'}>
                    <strong>{l.name}</strong> <span className="muted small">{l.lead_no}</span><br />
                    <span className="small">{l.phone} · {l.source_name}</span><br />
                    <span className={l.overdue ? 'small error' : 'small muted'}>{l.next_follow_up_at ? `Follow up ${dateTime(l.next_follow_up_at)}` : 'No follow-up set'}</span>
                    {l.owner_name && <span className="small muted"> · {l.owner_name}</span>}
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
