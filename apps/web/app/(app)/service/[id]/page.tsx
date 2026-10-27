'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  ActionButton, Card, ErrorBox, FormModal, KV, Loading, Modal, Page, SmartButton, StatusBar, Table, UploadField, date, dateTime, inr, num,
} from '@/components/ui';
import { SerialPicker } from '@/components/serials';
import { JOB_STEPS, JOB_STEP_LABELS } from '@/components/service';
import { api, post, useGet, useSaving } from '@/lib/api';
import { useCan } from '@/lib/session';

type Open = 'diagnose' | 'line' | 'fault' | 'cancel' | 'claim' | { fit: any } | null;

/**
 * One job card, from taking the unit in to handing it back: the unit and the customer, the warranty of the
 * unit and of each part inside it, the parts and labour with what the customer pays and what the warranty
 * covers, the faults found, photos, and claims made on suppliers. The buttons change with the step.
 */
export default function JobCardPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const write = can('service:write');
  const approver = can('service:approve');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/service/jobs/${id}`);
  const [open, setOpen] = useState<Open>(null);
  const [link, setLink] = useState<string | null>(null);
  const j = data?.data;
  if (!j) return <Page title="Job card"><Loading loading={loading} error={error} /></Page>;

  const move = (to: string, extra: object = {}) => post<{ data: any }>(`/service/jobs/${id}/move`, { to, ...extra });
  const toPay = Number(j.chargeable.grand_total);
  const editable = ['open', 'diagnosed', 'estimate_sent'].includes(j.status);
  const step = j.status === 'cancelled' ? 0 : JOB_STEPS.indexOf(j.status);
  const estimateLink = link ?? j.estimate_url;

  return (
    <Page title={`Job ${j.job_no}`}
      smart={
        <>
          <SmartButton icon="me" value={j.party_name} label={j.party_phone ?? 'Customer'} href={`/parties/${j.party_id}`} />
          <SmartButton icon="service" value={j.serial_no} label={j.item_name} href={`/units/${j.unit_id}`} />
          <SmartButton icon="rupee" value={`₹${inr(toPay)}`} label="Customer pays" />
          {j.invoice_id ? <SmartButton icon="accounts" value={j.invoice_no} label="The bill" href={`/invoices/${j.invoice_id}`} /> : null}
        </>
      }
      status={<StatusBar steps={JOB_STEP_LABELS} current={step} stopped={j.status === 'cancelled' ? 'Cancelled' : null} />}
      actions={write ? (
        <>
          {['open', 'approved', 'in_progress'].includes(j.status) ? (
            <button type="button" className={j.status === 'open' ? 'primary' : undefined} onClick={() => setOpen('diagnose')}>{j.status === 'open' ? 'Diagnose' : 'More work found'}</button>
          ) : null}
          {j.status === 'diagnosed' && toPay > 0 ? (
            <ActionButton kind="primary" onClick={() => move('estimate_sent')} onDone={(r) => { setLink(r.data.estimate_url); reload(); }}>Send estimate</ActionButton>
          ) : null}
          {['diagnosed', 'estimate_sent'].includes(j.status) && j.lines.length > 0 ? (
            <ActionButton kind={toPay === 0 ? 'primary' : undefined} confirm={toPay > 0 ? `Record that the customer approved ₹${inr(toPay)}?` : undefined}
              onClick={() => move('approved')} onDone={reload}>{toPay > 0 ? 'Customer approved' : 'Approve: all under warranty'}</ActionButton>
          ) : null}
          {j.status === 'approved' ? <ActionButton kind="primary" onClick={() => move('in_progress')} onDone={reload}>Start work</ActionButton> : null}
          {j.status === 'in_progress' ? <ActionButton kind="primary" onClick={() => move('ready')} onDone={reload}>Ready</ActionButton> : null}
          {j.status === 'ready' ? (
            <ActionButton kind="primary" confirm={toPay > 0 ? `Hand the unit back and bill ₹${inr(toPay)}?` : 'Hand the unit back? Nothing is billed: it is all under warranty.'}
              onClick={() => post(`/service/jobs/${id}/deliver`, {})} onDone={reload}>Deliver</ActionButton>
          ) : null}
          {!['ready', 'delivered', 'cancelled'].includes(j.status) ? <button type="button" className="danger" onClick={() => setOpen('cancel')}>Cancel</button> : null}
        </>
      ) : null}>

      {estimateLink && j.status === 'estimate_sent' ? (
        <div className="notice">
          Estimate sent. The customer approves it here: <a href={estimateLink} target="_blank" rel="noreferrer">{estimateLink}</a>
          {' · '}<button type="button" className="linkish" onClick={() => void navigator.clipboard?.writeText(estimateLink)}>Copy</button>
          {j.party_phone ? <>{' · '}<a href={`https://wa.me/${String(j.party_phone).replace(/\D/g, '')}?text=${encodeURIComponent(`Your ${j.item_name} (${j.job_no}): the estimate is ₹${inr(toPay)}. See it and approve here: ${estimateLink}`)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a></> : null}
        </div>
      ) : null}

      <div className="grid">
        <Card title="The unit">
          <KV rows={[
            ['Unit', <>{j.item_name} · <Link href={`/units/${j.unit_id}`}>{j.serial_no}</Link></>],
            ['Complaint', <span style={{ whiteSpace: 'pre-wrap' }}>{j.complaint}</span>],
            ['Diagnosis', j.diagnosis ? <span style={{ whiteSpace: 'pre-wrap' }}>{j.diagnosis}</span> : <span className="muted">Not yet</span>],
            ['Odometer', j.odometer_km != null ? `${num(j.odometer_km)} km` : null], ['Charge cycles', j.battery_cycles != null ? num(j.battery_cycles) : null],
            ['Technician', j.technician_name], ['Workshop', j.location],
            ['Taken in', dateTime(j.created_at)], ['Promised by', j.promised_at ? dateTime(j.promised_at) : null],
            ['Approved', j.approved_at ? `${dateTime(j.approved_at)}${j.approved_via === 'link' ? ', by the customer from the link' : j.approved_via === 'warranty' ? ', all under warranty' : ''}` : null],
            ['Closed', j.closed_at ? dateTime(j.closed_at) : null], ['Cancelled because', j.cancel_reason],
          ]} />
        </Card>
        <Card title="Warranty">
          <Table rows={j.warranty} columns={[
            { key: 'item_name', title: 'Unit and parts inside', render: (r) => <span style={{ paddingLeft: r.depth * 14 }}>{r.item_name} <span className="muted small">{r.serial_no}</span></span> },
            { key: 'sold_on', title: 'Sold', render: (r) => date(r.sold_on) },
            { key: 'valid', title: 'Warranty', render: (r) => <span className={`badge ${r.valid ? 'green' : 'grey'}`}>{r.valid ? `Covered · ${r.reason}` : r.reason}</span> },
          ]} />
        </Card>
      </div>

      <Card title="Parts and labour" actions={write && editable ? <button type="button" onClick={() => setOpen('line')}>+ Part or labour</button> : null}>
        <Table rows={j.lines} empty="Nothing yet. Add the parts and labour the job needs." columns={[
          { key: 'kind', title: '', render: (r) => <span className="muted small">{r.kind === 'part' ? 'Part' : 'Labour'}</span> },
          { key: 'item_name', title: 'Item', render: (r) => <>{r.item_name}{r.serials?.length ? <div className="small">Serial: {r.serials.join(', ')}</div> : null}</> },
          { key: 'qty', title: 'Qty', align: 'right', render: (r) => num(r.qty) },
          { key: 'rate', title: 'Rate', align: 'right', render: (r) => inr(r.rate) },
          { key: 'line_total', title: 'Amount', align: 'right', render: (r) => (r.is_warranty ? <span className="badge green">Warranty · free</span> : inr(r.line_total)) },
          { key: 'issued_qty', title: 'Fitted', align: 'right', render: (r) => (r.kind === 'part' ? `${num(r.issued_qty)} of ${num(r.qty)}` : '') },
          { key: 'x', title: '', render: (r) => (write ? (
            <span className="actions">
              {r.kind === 'part' && ['approved', 'in_progress'].includes(j.status) && Number(r.issued_qty) < Number(r.qty) ? <button type="button" onClick={() => setOpen({ fit: r })}>Fit</button> : null}
              {editable ? <ActionButton confirm={`Take ${r.item_name} off the job?`} onClick={() => api(`/service/jobs/${id}/lines/${r.id}`, { method: 'DELETE' })} onDone={reload}>Remove</ActionButton> : null}
            </span>
          ) : null) },
        ]} />
        <div className="totals" style={{ marginTop: 10 }}>
          <div><span>Chargeable, before GST</span><span>{inr(j.chargeable.taxable_total)}</span></div>
          {Number(j.chargeable.igst_total) ? <div><span>IGST</span><span>{inr(j.chargeable.igst_total)}</span></div>
            : <><div><span>CGST</span><span>{inr(j.chargeable.cgst_total)}</span></div><div><span>SGST</span><span>{inr(j.chargeable.sgst_total)}</span></div></>}
          <div className="grand"><span>Customer pays</span><span>₹{inr(j.chargeable.grand_total)}</span></div>
          <div className="muted"><span>Covered by warranty</span><span>₹{inr(j.free.grand_total)}</span></div>
        </div>
      </Card>

      <div className="grid">
        <Card title="Faults found" actions={write && j.status !== 'delivered' && j.status !== 'cancelled' ? <button type="button" onClick={() => setOpen('fault')}>+ Fault</button> : null}>
          <Table rows={j.faults} empty="None recorded." columns={[
            { key: 'code', title: 'Code', render: (r) => <strong>{r.code}</strong> }, { key: 'component', title: 'Component' },
            { key: 'description', title: 'What' }, { key: 'serial_no', title: 'In', render: (r) => r.serial_no ?? j.serial_no },
          ]} />
        </Card>
        <Card title="Supplier claims" actions={approver ? <button type="button" onClick={() => setOpen('claim')}>+ Claim</button> : null}>
          <Table rows={j.claims} empty="None." columns={[
            { key: 'item_name', title: 'Unit', render: (r) => <>{r.item_name} <span className="muted small">{r.serial_no}</span></> },
            { key: 'supplier_name', title: 'Supplier' },
            { key: 'status', title: 'Status', render: (r) => <span className="badge">{r.status}</span> },
            { key: 'amount', title: 'Amount', align: 'right', render: (r) => (r.amount ? inr(r.amount) : '') },
          ]} />
          {j.claims.length ? <p className="small" style={{ marginTop: 8 }}><Link href="/service/claims">All supplier claims</Link></p> : null}
        </Card>
      </div>

      <Card title="Photos and documents">
        <div className="chips" style={{ marginBottom: 8 }}>
          {j.media.length === 0 ? <span className="muted small">None yet.</span> : null}
          {j.media.map((mda: any) => <a key={mda.id} className="chip" href={`/api/files/${mda.file_id}`} target="_blank" rel="noreferrer">{mda.caption ?? mda.original_name}</a>)}
        </div>
        {write && j.status !== 'delivered' && j.status !== 'cancelled' ? (
          <UploadField purpose="service" value="" onChange={(url) => { if (url) void post(`/service/jobs/${id}/media`, { file_id: url.split('/').pop() }).then(reload); }} />
        ) : null}
      </Card>

      {open === 'diagnose' ? (
        <FormModal title={j.status === 'open' ? `Diagnose ${j.job_no}` : 'More work found'} submit="Save" onClose={() => setOpen(null)} onDone={reload}
          intro={j.status !== 'open' ? <p className="muted small">The job goes back to diagnosed: add the work, and the customer approves again.</p> : undefined}
          initial={{ diagnosis: j.diagnosis ?? '' }} fields={[{ name: 'diagnosis', label: 'What is wrong', type: 'textarea', required: true }]}
          onSubmit={(v) => move('diagnosed', { diagnosis: v.diagnosis })} />
      ) : null}
      {open === 'line' ? <AddLine jobId={id} approver={approver} onClose={() => setOpen(null)} onDone={reload} /> : null}
      {open === 'fault' ? (
        <AddFault job={j} onClose={() => setOpen(null)} onDone={reload} />
      ) : null}
      {open === 'claim' ? <NewClaim job={j} onClose={() => setOpen(null)} onDone={reload} /> : null}
      {open === 'cancel' ? (
        <FormModal title={`Cancel ${j.job_no}`} submit="Cancel the job" onClose={() => setOpen(null)} onDone={reload}
          fields={[{ name: 'reason', label: 'Why', type: 'textarea', required: true }]} onSubmit={(v) => move('cancelled', { reason: v.reason })} />
      ) : null}
      {open && typeof open === 'object' ? <FitPart job={j} line={open.fit} onClose={() => setOpen(null)} onDone={reload} /> : null}
    </Page>
  );
}

function AddLine({ jobId, approver, onClose, onDone }: { jobId: string; approver: boolean; onClose: () => void; onDone: () => void }) {
  const items = useGet<{ data: any[] }>('/items?limit=2000');
  const all = (items.data?.data ?? []).filter((i) => i.item_type !== 'raw_material' && i.active);
  return (
    <FormModal title="Add a part or labour" submit="Add" onClose={onClose} onDone={onDone}
      intro={<p className="muted small">The rate comes from the customer's price list. Whether it is under warranty is worked out from the unit{approver ? '; you can change it' : ''}.</p>}
      initial={{ kind: 'part', qty: '1', warranty: '' }}
      fields={[
        { name: 'kind', label: 'Part or labour', type: 'select', required: true, options: [{ value: 'part', label: 'Part (from the workshop shelf)' }, { value: 'labour', label: 'Labour' }] },
        { name: 'item_id', label: 'Item', type: 'select', required: true, options: all.map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` })) },
        { name: 'qty', label: 'Qty (hours for labour)', type: 'number', required: true },
        ...(approver ? [{ name: 'warranty', label: 'Warranty', type: 'select' as const, options: [{ value: '', label: 'As the unit\'s warranty says' }, { value: 'yes', label: 'Free under warranty' }, { value: 'no', label: 'Chargeable' }] }] : []),
      ]}
      onSubmit={(v) => post(`/service/jobs/${jobId}/lines`, { kind: v.kind, item_id: v.item_id, qty: v.qty, ...(v.warranty ? { is_warranty: v.warranty === 'yes' } : {}) })} />
  );
}

function AddFault({ job, onClose, onDone }: { job: any; onClose: () => void; onDone: () => void }) {
  const codes = useGet<{ data: any[] }>('/service/fault-codes');
  return (
    <FormModal title="A fault found" submit="Add" onClose={onClose} onDone={onDone}
      fields={[
        { name: 'fault_code_id', label: 'Fault code', type: 'select', required: true, options: (codes.data?.data ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: `${c.code} · ${c.component} · ${c.description}` })) },
        { name: 'unit_id', label: 'Found in', type: 'select', options: [{ value: '', label: `${job.item_name} ${job.serial_no}` }, ...job.parts_inside.map((p: any) => ({ value: p.id, label: `${p.item_name} ${p.serial_no}` }))] },
        { name: 'notes', label: 'Notes' },
      ]}
      onSubmit={(v) => post(`/service/jobs/${job.id}/faults`, { fault_code_id: v.fault_code_id, unit_id: v.unit_id || null, notes: v.notes || null })} />
  );
}

function NewClaim({ job, onClose, onDone }: { job: any; onClose: () => void; onDone: () => void }) {
  const suppliers = useGet<{ data: any[] }>('/parties?type=supplier&limit=2000');
  return (
    <FormModal title="Claim on the supplier" submit="Open the claim" onClose={onClose} onDone={onDone}
      intro={<p className="muted small">The job's photos go with the claim as evidence.</p>}
      fields={[
        { name: 'unit_id', label: 'The failed unit', type: 'select', required: true, options: [{ value: job.unit_id, label: `${job.item_name} ${job.serial_no}` }, ...job.parts_inside.map((p: any) => ({ value: p.id, label: `${p.item_name} ${p.serial_no}` }))] },
        { name: 'supplier_id', label: 'Supplier', type: 'select', required: true, options: (suppliers.data?.data ?? []).map((p) => ({ value: p.id, label: p.name })) },
        { name: 'amount', label: 'Amount claimed ₹', type: 'number' }, { name: 'notes', label: 'Notes', type: 'textarea' },
      ]}
      onSubmit={(v) => post('/service/claims', { job_card_id: job.id, unit_id: v.unit_id, supplier_id: v.supplier_id, amount: v.amount || null, notes: v.notes || null })} />
  );
}

/** Fit a part from the workshop shelf; a part kept by serial is picked from what is there. */
function FitPart({ job, line, onClose, onDone }: { job: any; line: any; onClose: () => void; onDone: () => void }) {
  const saving = useSaving();
  const left = Number(line.qty) - Number(line.issued_qty);
  const [qty, setQty] = useState(String(left));
  const [serials, setSerials] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Fit ${line.item_name}`} onClose={onClose}>
      <div className="form">
        <label><span>How many ({left} to fit)</span><input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
      </div>
      {line.is_serialised ? <SerialPicker itemId={line.item_id} locationId={job.location_id} qty={Number(qty) || 0} value={serials} onChange={(s) => { setSerials(s); setQty(String(s.length)); }} /> : null}
      <p className="muted small">{line.is_warranty ? 'Under warranty: its cost goes to warranty expense.' : 'Chargeable: it is billed when the unit is delivered.'}</p>
      <ErrorBox error={error} />
      <div className="form-foot">
        <button type="button" className="primary" disabled={saving.busy} onClick={() => saving.run(async () => {
          setError(null);
          try {
            await post(`/service/jobs/${job.id}/lines/${line.id}/issue`, { qty, ...(serials.length ? { serials } : {}) });
            onDone(); onClose();
          } catch (e) { setError((e as Error).message); }
        })}>{saving.busy ? 'Saving…' : 'Fit'}</button>
      </div>
    </Modal>
  );
}
