'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { type LeadStage } from '@radcore/shared';
import { Conversation, QuickReplies, ScoreCard, ShareFiles } from '@/components/crm';
import { LeadMoveDialog, cannotMove, moveNow, needsAsking } from '@/components/lead-move';
import { PlanCard } from '@/components/leadtools';
import { Badge, Card, ErrorBox, FormModal, KV, Loading, Page, SmartButton, StatusBar, Table, date, dateTime, inr, label } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const iso = (v: string) => (v ? new Date(v).toISOString() : null);
/** The stages along the strip at the top; Lost is the red end it can stop at instead. */
const ROAD: LeadStage[] = ['new', 'contacted', 'interested', 'meeting_booked', 'converted'];
const ROAD_LABELS = ['New', 'Contacted', 'Interested', 'Meeting booked', 'Won'];
const rupees = (v: unknown) => `₹${inr(v).replace(/\.00$/, '')}`;

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/leads/${id}`);
  const reasons = useGet<{ data: any[] }>('/masters/lost-reasons');
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  // Which pop-up is open: a move that needs something, or one of the record's own forms.
  const [moving, setMoving] = useState<LeadStage | null>(null);
  const [open, setOpen] = useState<'value' | 'log' | 'owner' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lead = data?.data;
  if (!lead) return <Page title="Lead"><Loading loading={loading} error={error} /></Page>;

  const write = can('leads:write');
  const closed = lead.stage === 'converted' || lead.stage === 'lost';
  const wa = `https://wa.me/${String(lead.phone).replace(/\D/g, '')}`;
  const orders: any[] = lead.orders ?? [];
  const ordered = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'draft').reduce((t, o) => t + Number(o.amount), 0);

  /** Move to a stage: straight away when nothing is needed, else through its pop-up. */
  async function go(to: LeadStage) {
    setProblem(null);
    const no = cannotMove(lead, to);
    if (no) return setProblem(no);
    if (needsAsking(lead, to)) return setMoving(to);
    try {
      await moveNow(lead, to);
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  return (
    <Page title={`${lead.lead_no} · ${lead.name}`}
      smart={
        <>
          <SmartButton icon="rupee" value={lead.deal_value ? rupees(lead.deal_value) : 'Not set'} label="Deal value" onClick={write ? () => setOpen('value') : undefined} />
          <SmartButton icon="sales" value={orders.length} label={ordered ? `Orders · ${rupees(ordered)}` : 'Quotes & orders'} href={orders.length ? '#orders' : null} />
          {lead.party_id ? <SmartButton icon="me" value={lead.party_name} label="Customer" href={`/parties/${lead.party_id}`} /> : null}
          {!closed ? <SmartButton icon="calendar" value={lead.next_follow_up_at ? date(lead.next_follow_up_at) : 'None'} label="Next follow-up"
            tone={lead.next_follow_up_at && new Date(lead.next_follow_up_at) < new Date() ? 'red' : undefined} /> : null}
        </>
      }
      status={
        <StatusBar steps={ROAD_LABELS} current={ROAD.indexOf(lead.stage)}
          stopped={lead.stage === 'lost' ? `Lost${lead.lost_reason ? `: ${lead.lost_reason}` : ''}` : null}
          onPick={write && lead.stage !== 'converted' ? (i) => go(ROAD[i]!) : undefined} />
      }
      actions={
        <>
          <a className="button" href={`tel:${lead.phone}`}>Call</a>
          <a className="button" target="_blank" rel="noreferrer" href={wa}>WhatsApp</a>
          {write && !closed ? <button type="button" onClick={() => setOpen('log')}>Log activity</button> : null}
          {can('sales:write') && lead.stage !== 'lost' ? (
            <Link className="button" href={`/sales/orders/new?lead_id=${lead.id}${lead.party_id ? `&party_id=${lead.party_id}` : ''}`}>New quote</Link>
          ) : null}
          {write && !closed ? <button type="button" className="primary" onClick={() => go('converted')}>Won</button> : null}
          {write && !closed ? <button type="button" className="danger" onClick={() => go('lost')}>Lost</button> : null}
          {write && lead.stage === 'lost' ? <button type="button" onClick={() => go('contacted')}>Take it back</button> : null}
        </>
      }>
      <ErrorBox error={problem} />
      <Card>
        <KV rows={[
          ['Stage', <><Badge value={lead.stage} /> {lead.lost_reason}</>],
          ['Deal value', <span id="deal">{lead.deal_value ? rupees(lead.deal_value) : <span className="muted">Not set</span>}{write ? <> · <button type="button" className="link" onClick={() => setOpen('value')}>{lead.deal_value ? 'Change' : 'Set a value'}</button></> : null}</span>],
          ['Phone', lead.phone], ['Email', lead.email],
          ['Source', `${lead.source_name}${lead.source_detail ? ` · ${lead.source_detail}` : ''}`],
          ['Owner', <>{lead.owner_name}{write ? <> <button type="button" className="link" onClick={() => setOpen('owner')}>Reassign</button></> : null}</>],
          ['Attended by', lead.attended_by_name],
          ['Next follow-up', dateTime(lead.next_follow_up_at)],
          ['Interested in', (lead.interested_items ?? []).map((i: any) => i.name).join(', ')],
          ['Party', lead.party_id ? <Link href={`/parties/${lead.party_id}`}>{lead.party_name}</Link> : null],
          ['Captured', dateTime(lead.created_at)], ['Converted', dateTime(lead.converted_at)],
          ['Notes', lead.notes],
        ]} />
      </Card>

      <ScoreCard lead={lead} />

      {lead.stage !== 'converted' && lead.stage !== 'lost' ? <PlanCard leadId={id} plan={lead.plan} phone={lead.phone} canChange={write} onDone={reload} /> : null}

      {write && <QuickReplies leadId={id} phone={lead.phone} onDone={reload} />}

      <Conversation leadId={id} activities={lead.activities ?? []} canSend={write} onDone={reload} />

      <ShareFiles leadId={id} phone={lead.phone} name={lead.name} canSend={write} />

      {orders.length > 0 ? (
        <Card title="Quotes and orders for this lead" id="orders">
          <Table rows={orders} rowHref={(r) => `/sales/orders/${r.id}`} columns={[
            { key: 'order_no', title: 'Number' },
            { key: 'order_date', title: 'Date', render: (r) => date(r.order_date) },
            { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
            { key: 'amount', title: 'Value before GST', align: 'right', render: (r) => inr(r.amount) },
          ]} />
        </Card>
      ) : null}

      {moving ? (
        <LeadMoveDialog lead={lead} to={moving} reasons={reasons.data?.data ?? []}
          onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />
      ) : null}
      {open === 'value' ? (
        <FormModal title="Deal value" submit="Save" onClose={() => setOpen(null)}
          intro={<p className="muted small">What this deal is expected to be worth. The pipeline adds these up stage by stage; leave it blank to count the price of what the lead asked about instead.</p>}
          initial={{ deal_value: lead.deal_value ?? '' }}
          fields={[{ name: 'deal_value', label: 'Deal value ₹', type: 'number' }]}
          onSubmit={(v) => patch(`/leads/${id}`, { deal_value: v.deal_value })} onDone={reload} />
      ) : null}
      {open === 'log' ? (
        <FormModal title="Log activity" submit="Log" onClose={() => setOpen(null)}
          initial={{ type: 'call' }}
          fields={[
            { name: 'type', label: 'Type', type: 'select', required: true, options: ['call', 'whatsapp', 'meeting', 'note'].map((t) => ({ value: t, label: label(t) })) },
            { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime-local' },
            { name: 'note', label: 'Note', type: 'textarea' },
          ]}
          onSubmit={(v) => post(`/leads/${id}/activities`, { ...v, next_follow_up_at: iso(v.next_follow_up_at) })}
          onDone={reload} />
      ) : null}
      {open === 'owner' ? (
        <FormModal title="Reassign" submit="Save" onClose={() => setOpen(null)}
          initial={{ owner_id: lead.owner_id ?? '' }}
          fields={[{ name: 'owner_id', label: 'Owner', type: 'select', required: true, options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) }]}
          onSubmit={(v) => patch(`/leads/${id}`, v)} onDone={reload} />
      ) : null}

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
