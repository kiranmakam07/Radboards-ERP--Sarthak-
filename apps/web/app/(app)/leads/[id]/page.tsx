'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PAYMENT_MODES, type LeadStage } from '@radcore/shared';
import { Conversation, QuickReplies, ScoreCard, ShareFiles } from '@/components/crm';
import { LeadMoveDialog, cannotMove, moveNow, needsAsking } from '@/components/lead-move';
import { PlanCard } from '@/components/leadtools';
import { ActionButton, Badge, Card, ErrorBox, FormModal, KV, Loading, Modal, Page, SmartButton, StatusBar, Table, date, dateTime, inr, label } from '@/components/ui';
import { SerialPicker } from '@/components/serials';
import { patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const iso = (v: string) => (v ? new Date(v).toISOString() : null);
/** The stages along the strip at the top; Lost is the red end it can stop at instead. */
const ROAD: LeadStage[] = ['new', 'contacted', 'interested', 'meeting_booked', 'test_ride_booked', 'test_ride_done', 'quoted', 'booked', 'delivered', 'converted'];
const ROAD_LABELS = ['New', 'Contacted', 'Interested', 'Meeting', 'Ride booked', 'Ridden', 'Quoted', 'Booked', 'Delivered', 'Won'];
/** Stages from which a test ride or a booking can still be made. */
const DECIDING: LeadStage[] = ['new', 'contacted', 'interested', 'meeting_booked', 'test_ride_booked', 'test_ride_done', 'quoted'];
const rupees = (v: unknown) => `₹${inr(v).replace(/\.00$/, '')}`;

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/leads/${id}`);
  const reasons = useGet<{ data: any[] }>('/masters/lost-reasons');
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  // Which pop-up is open: a move that needs something, or one of the record's own forms.
  const [moving, setMoving] = useState<LeadStage | null>(null);
  const [open, setOpen] = useState<'value' | 'log' | 'owner' | 'ride' | 'book' | null>(null);
  const rides = useGet<{ data: any[] }>(`/pipeline/test-rides${qs({ lead_id: id })}`);
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
          {write && DECIDING.includes(lead.stage) ? <button type="button" onClick={() => setOpen('ride')}>Book a test ride</button> : null}
          {can('sales:write') && DECIDING.includes(lead.stage) ? <button type="button" onClick={() => setOpen('book')}>Book the vehicle</button> : null}
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
          ['Agreed to be contacted', lead.consent_at ? `${dateTime(lead.consent_at)} · ${lead.consent_source}` : <span className="muted">Not recorded</span>],
          ['Notes', lead.notes],
        ]} />
      </Card>

      <ScoreCard lead={lead} />

      {lead.stage !== 'converted' && lead.stage !== 'lost' ? <PlanCard leadId={id} plan={lead.plan} phone={lead.phone} canChange={write} onDone={reload} /> : null}

      {write && <QuickReplies leadId={id} phone={lead.phone} onDone={reload} />}

      <Conversation leadId={id} activities={lead.activities ?? []} canSend={write} onDone={reload} />

      <ShareFiles leadId={id} phone={lead.phone} name={lead.name} canSend={write} />

      {(rides.data?.data ?? []).length > 0 ? (
        <Card title="Test rides">
          <Table rows={rides.data!.data} columns={[
            { key: 'slot_at', title: 'When', render: (r) => `${dateTime(r.slot_at)} · ${r.minutes} min` },
            { key: 'serial_no', title: 'On', render: (r) => `${r.item_name} ${r.serial_no}` },
            { key: 'staff_name', title: 'With' },
            { key: 'outcome', title: 'How it went', render: (r) => <>{label(r.outcome)}{r.notes ? <div className="muted small">{r.notes}</div> : null}</> },
            { key: 'x', title: '', render: (r) => (write && r.outcome === 'booked' ? (
              <span className="actions">
                <ActionButton onClick={() => post(`/pipeline/test-rides/${r.id}/outcome`, { outcome: 'done' })} onDone={() => { rides.reload(); reload(); }}>Done</ActionButton>
                <ActionButton onClick={() => post(`/pipeline/test-rides/${r.id}/outcome`, { outcome: 'no_show' })} onDone={rides.reload}>No show</ActionButton>
                <ActionButton onClick={() => post(`/pipeline/test-rides/${r.id}/outcome`, { outcome: 'cancelled' })} onDone={rides.reload}>Cancel</ActionButton>
              </span>
            ) : null) },
          ]} />
        </Card>
      ) : null}

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
      {open === 'ride' ? <TestRideForm leadId={id} onClose={() => setOpen(null)} onDone={() => { rides.reload(); reload(); }} /> : null}
      {open === 'book' ? <BookingForm leadId={id} onClose={() => setOpen(null)} onDone={reload} /> : null}
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

/** A test ride on a demo unit: no demo unit is booked twice for the same time. */
function TestRideForm({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: () => void }) {
  const units = useGet<{ data: any[] }>('/pipeline/demo-units');
  return (
    <FormModal title="Book a test ride" submit="Book" onClose={onClose} onDone={onDone}
      intro={<p className="muted small">On a demo unit. The lead moves to Test Ride Booked; mark the ride done afterwards.</p>}
      initial={{ minutes: '30' }}
      fields={[
        { name: 'unit_id', label: 'Demo unit', type: 'select', required: true, options: (units.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.item_name} ${u.serial_no}${u.location ? ` · ${u.location}` : ''}` })) },
        { name: 'slot_at', label: 'When', type: 'datetime-local', required: true },
        { name: 'minutes', label: 'Minutes', type: 'number', required: true },
        { name: 'notes', label: 'Notes' },
      ]}
      onSubmit={(v) => post(`/pipeline/leads/${leadId}/test-rides`, { unit_id: v.unit_id, slot_at: new Date(`${v.slot_at}:00+05:30`).toISOString(), minutes: v.minutes, notes: v.notes || null })} />
  );
}

/** A booking: the vehicle held by its serial on a confirmed order, and the advance received. */
function BookingForm({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: () => void }) {
  const items = useGet<{ data: any[] }>('/items?limit=2000');
  const places = useGet<{ data: any[] }>('/masters/locations');
  const vehicles = (items.data?.data ?? []).filter((i) => i.item_type === 'vehicle' && i.active);
  const sellFrom = (places.data?.data ?? []).filter((p) => p.active && ['stores', 'showroom', 'demo', 'franchise'].includes(p.type));
  const [v, setV] = useState({ item_id: '', location_id: '', mode: 'upi', amount: '', reference: '' });
  const [serials, setSerials] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const item = vehicles.find((i) => i.id === v.item_id);
  const place = v.location_id || sellFrom.find((p) => p.type === 'showroom')?.id || '';
  return (
    <Modal title="Book the vehicle" onClose={onClose}>
      <p className="muted small">A confirmed order at the price list rate, the vehicle held for it by serial, and the advance received. The lead moves to Booked.</p>
      <div className="form">
        <label><span>Vehicle</span>
          <select value={v.item_id} onChange={(e) => { setV({ ...v, item_id: e.target.value }); setSerials([]); }}>
            <option value="">Pick one</option>{vehicles.map((i) => <option key={i.id} value={i.id}>{i.name} · ₹{inr(i.retail_price)}</option>)}
          </select>
        </label>
        <label><span>From</span>
          <select value={place} onChange={(e) => { setV({ ...v, location_id: e.target.value }); setSerials([]); }}>
            {sellFrom.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label><span>Advance ₹</span><input type="number" min="0" step="any" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></label>
        <label><span>Paid by</span><select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></label>
        <label><span>Reference</span><input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></label>
      </div>
      {item && place ? <SerialPicker itemId={item.id} locationId={place} qty={1} value={serials} onChange={(sel) => setSerials(sel.slice(-1))} /> : null}
      <ErrorBox error={error} />
      <div className="form-foot">
        <button type="button" className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await post(`/pipeline/leads/${leadId}/booking`, { item_id: v.item_id, serial: serials[0] ?? '', location_id: place || null, advance: { mode: v.mode, amount: v.amount || '0', reference: v.reference || null } });
            onDone(); onClose();
          } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>Book</button>
      </div>
    </Modal>
  );
}
