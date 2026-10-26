'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CLAIM_STATUSES, CLAIM_TRANSITIONS, type ClaimStatus } from '@radcore/shared';
import { ActionButton, CsvLink, FormModal, Loading, Page, Table, date, inr, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Warranty claims on suppliers: draft, sent, accepted or rejected, and credited once their credit note comes. */
export default function SupplierClaimsPage() {
  const can = useCan();
  const approver = can('service:approve');
  const [status, setStatus] = useState<ClaimStatus | ''>('');
  const [crediting, setCrediting] = useState<any | null>(null);
  const path = `/service/claims${qs({ status })}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const move = (c: any, to: ClaimStatus) => post(`/service/claims/${c.id}/move`, { to });
  return (
    <Page title="Supplier claims" actions={<CsvLink href={path} />}>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as ClaimStatus | '')}>
          <option value="">All claims</option>
          {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No claims. A claim is opened from a job card." columns={[
        { key: 'job_no', title: 'Job', render: (c) => <Link href={`/service/${c.job_card_id}`}>{c.job_no}</Link> },
        { key: 'item_name', title: 'Failed unit', render: (c) => <>{c.item_name}<div className="muted small">{c.serial_no}{c.batch_no ? ` · batch ${c.batch_no}` : ''}</div></> },
        { key: 'supplier_name', title: 'Supplier' },
        { key: 'status', title: 'Status', render: (c) => <span className="badge">{label(c.status)}</span> },
        { key: 'amount', title: 'Amount', align: 'right', render: (c) => (c.amount ? inr(c.amount) : '') },
        { key: 'credit_note_ref', title: 'Credit note', render: (c) => c.credit_note_ref ?? '' },
        { key: 'created_at', title: 'Opened', render: (c) => date(c.created_at) },
        { key: 'x', title: '', render: (c) => (approver ? (
          <span className="actions">
            {CLAIM_TRANSITIONS[c.status as ClaimStatus].filter((to) => to !== 'credited').map((to) => (
              <ActionButton key={to} onClick={() => move(c, to)} onDone={reload}>{to === 'sent' ? 'Sent' : to === 'accepted' ? 'Accepted' : 'Rejected'}</ActionButton>
            ))}
            {c.status === 'accepted' ? <button type="button" onClick={() => setCrediting(c)}>Credited</button> : null}
          </span>
        ) : null) },
      ]} />
      {crediting ? (
        <FormModal title="The supplier's credit" submit="Record" onClose={() => setCrediting(null)} onDone={reload}
          intro={<p className="muted small">It lowers what we owe the supplier, and the warranty expense by the same amount.</p>}
          initial={{ amount: crediting.amount ?? '' }}
          fields={[{ name: 'amount', label: 'Amount credited ₹', type: 'number', required: true }, { name: 'credit_note_ref', label: 'Their credit note number', required: true }]}
          onSubmit={(v) => post(`/service/claims/${crediting.id}/move`, { to: 'credited', amount: v.amount, credit_note_ref: v.credit_note_ref })} />
      ) : null}
    </Page>
  );
}
