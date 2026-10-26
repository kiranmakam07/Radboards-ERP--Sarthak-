'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LEAD_STAGE_LABELS, OPEN_LEAD_STAGES, type LeadStage } from '@radcore/shared';
import { Board } from '@/components/board';
import { Score } from '@/components/crm';
import { LeadMoveDialog, cannotMove, moveNow, needsAsking, type MovingLead } from '@/components/lead-move';
import { ErrorBox, Loading, Page, date, inr } from '@/components/ui';
import { useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** The won and lost columns hold the last 30 days only, as the API's pipeline does. */
const HINTS: Partial<Record<LeadStage, string>> = {
  test_ride_booked: 'Booked from the lead', booked: 'Booked from the lead, with an advance', delivered: 'Delivered in the last 30 days',
  converted: 'Won in the last 30 days', lost: 'Lost in the last 30 days',
};
const TITLES: Record<LeadStage, string> = { ...LEAD_STAGE_LABELS, converted: 'Won' };
const rupees = (n: number) => `₹${inr(n).replace(/\.00$/, '')}`;

/**
 * Every open lead by stage, with what each stage is worth. A card is dragged to another stage; a
 * move that needs something (why it was lost, the next follow-up, the customer's details on a win)
 * asks in a pop-up first. Clicking a card opens the lead.
 */
export default function PipelinePage() {
  const router = useRouter();
  const can = useCan();
  const write = can('leads:write');
  const [mine, setMine] = useState(false);
  const { data, loading, error, reload } = useGet<{ data: any[]; stages: LeadStage[] }>(`/leads/pipeline${mine ? '?mine=true' : ''}`);
  const reasons = useGet<{ data: any[] }>('/masters/lost-reasons');
  const [moving, setMoving] = useState<Record<string, LeadStage>>({});
  const [asking, setAsking] = useState<{ lead: MovingLead; to: LeadStage } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setMoving({}); }, [data]);

  async function move(lead: any, to: string) {
    const stage = to as LeadStage;
    setProblem(null);
    const no = cannotMove(lead, stage);
    if (no) return setProblem(no);
    if (needsAsking(lead, stage)) return setAsking({ lead, to: stage });
    setMoving((m) => ({ ...m, [lead.id]: stage }));
    try {
      await moveNow(lead, stage);
      reload();
    } catch (e) {
      setMoving((m) => {
        const { [lead.id]: _gone, ...rest } = m;
        return rest;
      });
      setProblem(`${lead.name}: ${(e as Error).message}`);
    }
  }

  const stageOf = (l: any): string => moving[l.id] ?? l.stage;
  const columns = (data?.stages ?? []).map((stage) => {
    const total = (data?.data ?? []).filter((l) => stageOf(l) === stage).reduce((s, l) => s + Number(l.value), 0);
    return { key: stage, title: TITLES[stage], total: rupees(total), hint: HINTS[stage] };
  });

  return (
    <Page title="Pipeline" actions={
      <>
        {write ? <Link className="button primary" href="/leads?new=1">+ New lead</Link> : null}
        <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only</label>
        <Link className="button" href="/leads">List view</Link>
      </>
    }>
      <p className="muted small">
        Drag a lead to another stage to move it (on a phone, hold it for a moment first). Each stage shows what its leads are worth:
        the deal value where one is set; ≈ marks a lead without one, counted at the price of what it asked about.
      </p>
      <Loading loading={loading} error={error} />
      <ErrorBox error={problem} />
      {data ? (
        <Board columns={columns} items={data.data} keyOf={(l) => l.id} columnOf={stageOf}
          canMove={(l) => write && l.stage !== 'converted'} onMove={move} onOpen={(l) => router.push(`/leads/${l.id}`)}
          emptyColumn="No leads"
          render={(l) => (
            <>
              <div className="title">{l.name} <Score score={l.score} label={l.score_label} /></div>
              <div className="meta"><span>{l.lead_no} · {l.source_name}</span>{l.owner_name ? <span>{l.owner_name}</span> : null}</div>
              <div className="meta" style={{ justifyContent: 'space-between' }}>
                <strong style={{ color: 'var(--text)' }} title={l.value_from === 'items' ? 'No deal value yet: the price of what it asked about' : 'Deal value'}>
                  {l.value_from === 'items' && Number(l.value) > 0 ? '≈ ' : ''}{rupees(Number(l.value))}
                </strong>
                {OPEN_LEAD_STAGES.includes(l.stage) ? (
                  <span className={l.overdue ? 'late' : undefined}>{l.next_follow_up_at ? `${l.overdue ? 'Late · ' : 'Next '}${date(l.next_follow_up_at)}` : 'No follow-up'}</span>
                ) : null}
              </div>
            </>
          )} />
      ) : null}

      {asking ? (
        <LeadMoveDialog lead={asking.lead} to={asking.to} reasons={reasons.data?.data ?? []}
          onClose={() => setAsking(null)} onDone={() => { setAsking(null); reload(); }} />
      ) : null}
    </Page>
  );
}
