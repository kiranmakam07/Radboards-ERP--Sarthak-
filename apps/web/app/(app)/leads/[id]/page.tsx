'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { LEAD_STAGE_LABELS, LEAD_TRANSITIONS, type LeadStage } from '@radcore/shared';
import { Steps } from '@/components/charts';
import { QuickReplies, ScoreCard, ShareFiles } from '@/components/crm';
import { Badge, Card, Form, KV, Loading, Page, Table, dateTime, label } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const iso = (v: string) => (v ? new Date(v).toISOString() : null);

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/leads/${id}`);
  const reasons = useGet<{ data: any[] }>('/masters/lost-reasons');
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const lead = data?.data;
  if (!lead) return <Page title="Lead"><Loading loading={loading} error={error} /></Page>;

  const write = can('leads:write');
  // The stage machine is fixed (PRD 6.1): only offer the moves that are allowed from here.
  const moves = LEAD_TRANSITIONS[lead.stage as LeadStage].filter((s) => s !== 'converted');
  const canConvert = LEAD_TRANSITIONS[lead.stage as LeadStage].includes('converted');
  const wa = `https://wa.me/${String(lead.phone).replace(/\D/g, '')}`;

  return (
    <Page title={`${lead.lead_no} · ${lead.name}`} actions={
      <>
        <a className="button" href={`tel:${lead.phone}`}>Call</a>
        <a className="button" target="_blank" rel="noreferrer" href={wa}>WhatsApp</a>
      </>
    }>
      <Steps steps={['New', 'Contacted', 'Interested', 'Meeting booked', 'Converted']}
        current={lead.stage === 'converted' ? 5 : ['new', 'contacted', 'interested', 'meeting_booked'].indexOf(lead.stage)}
        stopped={lead.stage === 'lost' ? `Lost${lead.lost_reason ? `: ${lead.lost_reason}` : ''}` : null} />
      <Card>
        <KV rows={[
          ['Stage', <><Badge value={lead.stage} /> {lead.lost_reason}</>],
          ['Phone', lead.phone], ['Email', lead.email],
          ['Source', `${lead.source_name}${lead.source_detail ? ` · ${lead.source_detail}` : ''}`],
          ['Owner', lead.owner_name], ['Attended by', lead.attended_by_name],
          ['Next follow-up', dateTime(lead.next_follow_up_at)],
          ['Interested in', (lead.interested_items ?? []).map((i: any) => i.name).join(', ')],
          ['Party', lead.party_id ? <Link href={`/parties/${lead.party_id}`}>{lead.party_name}</Link> : null],
          ['Captured', dateTime(lead.created_at)], ['Converted', dateTime(lead.converted_at)],
          ['Notes', lead.notes],
        ]} />
      </Card>

      <ScoreCard lead={lead} />

      {write && <QuickReplies leadId={id} phone={lead.phone} onDone={reload} />}

      <ShareFiles leadId={id} phone={lead.phone} name={lead.name} canSend={write} />

      {write && lead.stage !== 'converted' && (
        <div className="grid">
          <Card title="Log activity">
            <Form submit="Log"
              initial={{ type: 'call' }}
              fields={[
                { name: 'type', label: 'Type', type: 'select', required: true, options: ['call', 'whatsapp', 'meeting', 'note'].map((t) => ({ value: t, label: label(t) })) },
                { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime-local' },
                { name: 'note', label: 'Note', type: 'textarea' },
              ]}
              onSubmit={(v) => post(`/leads/${id}/activities`, { ...v, next_follow_up_at: iso(v.next_follow_up_at) })}
              onDone={reload} />
          </Card>

          {moves.length > 0 && (
            <Card title="Move stage">
              <Form submit="Move"
                fields={[
                  { name: 'stage', label: 'To', type: 'select', required: true, options: moves.map((s) => ({ value: s, label: LEAD_STAGE_LABELS[s] })) },
                  { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime-local', help: 'Needed for Contacted / Interested / Meeting Booked' },
                  { name: 'lost_reason_id', label: 'Lost reason', type: 'select', help: 'Needed for Lost', options: (reasons.data?.data ?? []).filter((r) => r.active).map((r) => ({ value: r.id, label: r.name })) },
                  { name: 'note', label: 'Note', type: 'textarea' },
                ]}
                onSubmit={(v) => post(`/leads/${id}/stage`, { ...v, next_follow_up_at: iso(v.next_follow_up_at) })}
                onDone={reload} />
            </Card>
          )}

          {canConvert && (
            <Card title="Convert to party">
              <Form submit="Convert"
                initial={{ party_type: 'customer', name: lead.name }}
                fields={[
                  { name: 'party_type', label: 'As', type: 'select', required: true, options: [{ value: 'customer', label: 'Customer' }, { value: 'dealer', label: 'Dealer' }] },
                  { name: 'name', label: 'Party name', required: true },
                  { name: 'gstin', label: 'GSTIN (B2B)' },
                ]}
                onSubmit={(v) => post(`/leads/${id}/convert`, v)}
                onDone={reload} />
            </Card>
          )}

          <Card title="Reassign">
            <Form submit="Save"
              initial={{ owner_id: lead.owner_id ?? '' }}
              fields={[{ name: 'owner_id', label: 'Owner', type: 'select', required: true, options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) }]}
              onSubmit={(v) => patch(`/leads/${id}`, v)}
              onDone={reload} />
          </Card>
        </div>
      )}

      <Card title="Activity">
        <Table rows={lead.activities} empty="No activity yet." columns={[
          { key: 'at', title: 'When', render: (r) => dateTime(r.at) },
          { key: 'type', title: 'Type', render: (r) => label(r.type) },
          { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
          { key: 'user_name', title: 'By', render: (r) => r.user_name ?? 'System' },
        ]} />
      </Card>
    </Page>
  );
}
