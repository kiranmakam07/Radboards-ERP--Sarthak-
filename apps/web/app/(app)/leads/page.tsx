'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { LEAD_STAGES, LEAD_STAGE_LABELS, type LeadStage } from '@radcore/shared';
import { Score } from '@/components/crm';
import { BulkLeads, ImportLeads } from '@/components/leadtools';
import { Badge, CsvLink, FormModal, Loading, Page, Table, Toggle, dateTime, inr } from '@/components/ui';
import { patch, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

// Saved views (PRD 7.3): the questions people used to ask around for.
const VIEWS: [string, string][] = [
  ['', 'All leads'], ['followups_due', 'Follow-ups due'], ['overdue', 'Overdue'], ['interested_not_bought', 'Interested — not bought'],
  ['converted', 'Converted'], ['lost', 'Lost'],
];

function Leads() {
  const params = useSearchParams();
  const can = useCan();
  const [f, setF] = useState({ view: params.get('view') ?? '', q: '', stage: params.get('stage') ?? '', source_id: '', owner_id: '', mine: params.get('mine') ?? '', sort: '' });
  const sources = useGet<{ data: any[] }>('/masters/lead-sources');
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const items = useGet<{ data: any[] }>('/items?limit=1000');
  const path = `/leads${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  // Leads ticked on the list, to hand over or message together.
  const [picked, setPicked] = useState<string[]>([]);
  const tick = (leadId: string, on: boolean) => setPicked(on ? [...picked, leadId] : picked.filter((p) => p !== leadId));
  const shown = data?.data ?? [];
  const pickedLeads = shown.filter((l) => picked.includes(l.id));
  // The pipeline's "+ New lead" comes here with ?new=1.
  const [adding, setAdding] = useState(params.get('new') === '1');

  return (
    <Page title="Leads" actions={
      <>
        {can('leads:write') ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ New lead</button> : null}
        <CsvLink href={path} />
      </>
    }>
      {adding && (
        <FormModal title="New lead" submit="Save lead" onClose={() => setAdding(false)}
            intro={<p className="muted small">A phone number that is already a lead adds this enquiry to that lead instead of making a second one.</p>}
            fields={[
              { name: 'phone', label: 'Phone', type: 'tel', required: true },
              { name: 'name', label: 'Name', required: true },
              { name: 'source_id', label: 'Source', type: 'select', required: true, options: (sources.data?.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })) },
              { name: 'source_detail', label: 'Campaign / collaborator / batch' },
              { name: 'item', label: 'Interested in', type: 'select', options: (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
              { name: 'deal_value', label: 'Deal value ₹', type: 'number', help: 'What the deal may be worth, if known' },
              { name: 'owner_id', label: 'Owner (blank = auto-assign)', type: 'select', options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
              { name: 'next_follow_up_at', label: 'First follow-up', type: 'datetime-local' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onSubmit={async ({ item, next_follow_up_at, deal_value, ...v }) => {
              const made = await post<{ data: { id: string } }>('/leads', {
                ...v, interested_item_ids: item ? [item] : [],
                next_follow_up_at: next_follow_up_at ? new Date(next_follow_up_at).toISOString() : null,
              });
              if (deal_value) await patch(`/leads/${made.data.id}`, { deal_value });
              return made;
            }}
            onDone={reload} />
      )}
      {can('crm:manage') && (
        <Toggle label="+ Bring in from a spreadsheet">
          <ImportLeads sources={sources.data?.data ?? []} users={users.data?.data ?? []} onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        {VIEWS.map(([v, l]) => <button key={v} type="button" className={f.view === v ? 'primary' : undefined} onClick={() => set('view', v)}>{l}</button>)}
      </div>
      <div className="filters">
        <input placeholder="Search name, phone, lead no" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select value={f.stage} onChange={(e) => set('stage', e.target.value)}>
          <option value="">Any stage</option>{LEAD_STAGES.map((s) => <option key={s} value={s}>{LEAD_STAGE_LABELS[s]}</option>)}
        </select>
        <select value={f.source_id} onChange={(e) => set('source_id', e.target.value)}>
          <option value="">Any source</option>{(sources.data?.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={f.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
          <option value="">Any owner</option>{(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label><input type="checkbox" checked={f.mine === 'true'} onChange={(e) => set('mine', e.target.checked ? 'true' : '')} /> Mine only</label>
        <label><input type="checkbox" checked={f.sort === 'score'} onChange={(e) => set('sort', e.target.checked ? 'score' : '')} /> Hottest first</label>
      </div>
      <Loading loading={loading} error={error} />
      {pickedLeads.length > 0 && can('leads:write') ? (
        <BulkLeads picked={pickedLeads} users={users.data?.data ?? []} canAssign={can('crm:manage')} onClear={() => setPicked([])} onDone={reload} />
      ) : null}
      <Table rows={data?.data} rowHref={(r) => `/leads/${r.id}`}
        chart={{ kind: 'donut', name: 'Leads', label: (r) => LEAD_STAGE_LABELS[r.stage as LeadStage] ?? r.stage, value: () => 1 }} columns={[
        { key: 'lead_no', title: 'Lead' },
        { key: 'pick', title: 'Tick', render: (r) => (
          <input type="checkbox" checked={picked.includes(r.id)} aria-label={`Tick ${r.name}`} style={{ width: 'auto' }} onChange={(e) => tick(r.id, e.target.checked)} />
        ) },
        { key: 'name', title: 'Name' },
        { key: 'phone', title: 'Phone' },
        { key: 'stage', title: 'Stage', render: (r) => <><Badge value={r.stage} />{r.lost_reason ? <span className="muted small"> {r.lost_reason}</span> : null}</> },
        { key: 'score', title: 'Chance', render: (r) => <Score score={r.score} label={r.score_label} /> },
        { key: 'deal_value', title: 'Deal value', align: 'right', render: (r) => (r.deal_value ? `₹${inr(r.deal_value)}` : '') },
        { key: 'source_name', title: 'Source', render: (r) => <>{r.source_name}{r.source_detail ? <span className="muted small"> · {r.source_detail}</span> : null}</> },
        { key: 'interested_items', title: 'Interested in', render: (r) => (r.interested_items ?? []).join(', ') },
        { key: 'owner_name', title: 'Owner' },
        { key: 'next_follow_up_at', title: 'Next follow-up', render: (r) => <span className={r.overdue ? 'error small' : undefined}>{dateTime(r.next_follow_up_at)}</span> },
        { key: 'created_at', title: 'Captured', render: (r) => dateTime(r.created_at) },
      ]} />
    </Page>
  );
}

export default function LeadsPage() {
  return <Suspense><Leads /></Suspense>;
}
