'use client';

import { FOLLOW_UP_REQUIRED_STAGES, LEAD_STAGE_LABELS, LEAD_TRANSITIONS, type LeadStage } from '@radcore/shared';
import { FormModal } from '@/components/ui';
import { post } from '@/lib/api';

/**
 * Moving a lead to another stage, from the pipeline board (dragging a card) or from the lead's own
 * page (clicking a stage). The rules are the API's (moveLead and convertLead in
 * apps/api/src/modules/leads.ts); this asks for what a move needs before making it:
 *
 *   Lost                                    why it was lost (required)
 *   Contacted, Interested, Meeting booked   the next follow-up, when the lead has none
 *   Converted (won)                         customer or dealer, the party's name, its GSTIN
 *
 * Anything else moves straight away.
 */
export type MovingLead = { id: string; name: string; stage: LeadStage; next_follow_up_at: string | null };

/** Why a lead cannot go to a stage at all, or null when it can. */
export function cannotMove(lead: MovingLead, to: LeadStage): string | null {
  if (lead.stage === to) return null;
  if (!LEAD_TRANSITIONS[lead.stage].includes(to)) {
    return lead.stage === 'converted'
      ? `${lead.name} is already won; a won lead stays won.`
      : `A ${LEAD_STAGE_LABELS[lead.stage].toLowerCase()} lead cannot go to ${LEAD_STAGE_LABELS[to]}${lead.stage === 'lost' ? ': it can only be taken back to Contacted' : ''}.`;
  }
  return null;
}

/** True when moving there needs a pop-up first. */
export const needsAsking = (lead: MovingLead, to: LeadStage) =>
  to === 'lost' || to === 'converted' || (FOLLOW_UP_REQUIRED_STAGES.includes(to) && !lead.next_follow_up_at);

/** The move with nothing to ask. */
export const moveNow = (lead: MovingLead, to: LeadStage) => post(`/leads/${lead.id}/stage`, { stage: to });

const iso = (v: string) => (v ? new Date(v).toISOString() : null);

/** The pop-up for a move that needs something. Shown with {asking && <LeadMoveDialog …/>}. */
export function LeadMoveDialog({ lead, to, reasons, onClose, onDone }: {
  lead: MovingLead; to: LeadStage; reasons: { id: string; name: string; active: boolean }[]; onClose: () => void; onDone: () => void;
}) {
  if (to === 'converted') {
    return (
      <FormModal title={`Won: ${lead.name}`} submit="Mark as won" onClose={onClose} onDone={onDone}
        intro={<p className="muted small">The lead becomes a customer or a dealer, ready for a quote or a bill. Nothing is typed twice.</p>}
        initial={{ party_type: 'customer', name: lead.name }}
        fields={[
          { name: 'party_type', label: 'As', type: 'select', required: true, options: [{ value: 'customer', label: 'Customer' }, { value: 'dealer', label: 'Dealer' }, { value: 'franchisee', label: 'Franchisee' }] },
          { name: 'name', label: 'Name on bills', required: true },
          { name: 'gstin', label: 'GSTIN', help: 'For a business that claims GST' },
        ]}
        onSubmit={(v) => post(`/leads/${lead.id}/convert`, v)} />
    );
  }
  if (to === 'lost') {
    return (
      <FormModal title={`Lost: ${lead.name}`} submit="Mark as lost" onClose={onClose} onDone={onDone}
        fields={[
          { name: 'lost_reason_id', label: 'Why was it lost?', type: 'select', required: true, options: reasons.filter((r) => r.active).map((r) => ({ value: r.id, label: r.name })) },
          { name: 'note', label: 'Note', type: 'textarea' },
        ]}
        onSubmit={(v) => post(`/leads/${lead.id}/stage`, { stage: 'lost', ...v })} />
    );
  }
  return (
    <FormModal title={`${LEAD_STAGE_LABELS[to]}: ${lead.name}`} submit={`Move to ${LEAD_STAGE_LABELS[to]}`} onClose={onClose} onDone={onDone}
      intro={<p className="muted small">A lead at this stage always has a next follow-up, so it is never forgotten.</p>}
      fields={[
        { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime-local', required: true },
        { name: 'note', label: 'Note', type: 'textarea' },
      ]}
      onSubmit={(v) => post(`/leads/${lead.id}/stage`, { stage: to, note: v.note, next_follow_up_at: iso(v.next_follow_up_at) })} />
  );
}
