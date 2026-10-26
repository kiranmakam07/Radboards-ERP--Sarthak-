'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { JOB_CARD_STATUSES, JOB_CARD_STATUS_LABELS, type JobCardStatus } from '@radcore/shared';
import { Badge, CsvLink, FormModal, Loading, Page, Table, dateTime } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';
import { fromLocal } from '@/components/service';

/** Every job in the workshop; + Take in opens a job card for a unit by its serial. */
export default function JobCardsPage() {
  const can = useCan();
  const router = useRouter();
  const [f, setF] = useState({ q: '', status: '' as JobCardStatus | '' });
  const [adding, setAdding] = useState(false);
  const path = `/service/jobs${qs({ q: f.q, status: f.status, open: f.status ? undefined : 'true' })}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Job cards" actions={
      <>
        {can('service:write') ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ Take in</button> : null}
        <CsvLink href={path} />
      </>
    }>
      <div className="filters">
        <input placeholder="Search job no, serial, customer or phone" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="grow" />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as JobCardStatus | '' })}>
          <option value="">Open jobs</option>
          {JOB_CARD_STATUSES.map((s) => <option key={s} value={s}>{JOB_CARD_STATUS_LABELS[s]}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/service/${r.id}`} empty={f.status ? 'No jobs at this step.' : 'No open jobs. Take a unit in with + Take in.'} columns={[
        { key: 'job_no', title: 'Job', render: (r) => <strong>{r.job_no}</strong> },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'item_name', title: 'Unit', render: (r) => <>{r.item_name}<div className="muted small">{r.serial_no}</div></> },
        { key: 'party_name', title: 'Customer', render: (r) => <>{r.party_name}<div className="muted small">{r.party_phone}</div></> },
        { key: 'complaint', title: 'Complaint', render: (r) => <span className="clamp-2" title={r.complaint}>{r.complaint}</span> },
        { key: 'technician_name', title: 'Technician' },
        { key: 'promised_at', title: 'Promised', render: (r) => (r.promised_at ? dateTime(r.promised_at) : '') },
      ]} />
      {adding ? <TakeIn onClose={() => setAdding(false)} onDone={(id) => router.push(`/service/${id}`)} /> : null}
    </Page>
  );
}

/** The job card form: which unit (by serial), what the customer says, the readings, who works on it. */
function TakeIn({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const parties = useGet<{ data: any[] }>('/parties?side=customers&limit=2000');
  const techs = useGet<{ data: any[] }>('/service/technicians');
  return (
    <FormModal title="Take a unit in" submit="Open job card" wide onClose={onClose}
      intro={<p className="muted small">The warranty is checked from the serial. The customer is the one the unit was sold to, unless you pick another.</p>}
      fields={[
        { name: 'serial', label: 'Serial', required: true },
        { name: 'party_id', label: 'Customer (if not the one it was sold to)', type: 'select', options: (parties.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.name}${p.phone ? ` · ${p.phone}` : ''}` })) },
        { name: 'complaint', label: 'Complaint', type: 'textarea', required: true },
        { name: 'odometer_km', label: 'Odometer (km)', type: 'number' }, { name: 'battery_cycles', label: 'Battery charge cycles', type: 'number' },
        { name: 'promised_at', label: 'Promised by', type: 'datetime-local' },
        { name: 'technician_id', label: 'Technician', type: 'select', options: (techs.data?.data ?? []).map((t) => ({ value: t.id, label: t.name })) },
      ]}
      onSubmit={(v) => post<{ data: { id: string } }>('/service/jobs', {
        serial: v.serial, party_id: v.party_id || null, complaint: v.complaint, odometer_km: v.odometer_km || null, battery_cycles: v.battery_cycles || null,
        promised_at: fromLocal(v.promised_at), technician_id: v.technician_id || null,
      })}
      onDone={(r) => onDone(r.data.id)} />
  );
}
