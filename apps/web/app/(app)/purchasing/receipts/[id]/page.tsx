'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, KV, Loading, Page, Table, dateTime, inr, num, sub } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Goods received -> QC check -> inwarded to Stores / moved to Rejected -> returned to supplier (PRD 6.2). */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/purchasing/receipts/${id}`);
  const grn = data?.data;
  if (!grn) return <Page title="Goods receipt"><Loading loading={loading} error={error} /></Page>;
  const toReturn = grn.lines.reduce((s: number, l: any) => sub(s + Number(l.rejected_qty ?? 0), l.returned_qty), 0);

  return (
    <Page title={`Goods receipt ${grn.grn_no}`} actions={
      <>
        {can('grn:write') && grn.status === 'received' && (
          <ActionButton kind="danger" confirm="Cancel this receipt? Use this only if it was entered by mistake." onClick={() => post(`/purchasing/receipts/${id}/cancel`)} onDone={reload}>Cancel receipt</ActionButton>
        )}
        {can('grn:write') && grn.status === 'inwarded' && toReturn > 0 && (
          <ActionButton kind="primary" confirm={`Return ${toReturn} rejected unit(s) to the supplier and raise a debit note?`}
            onClick={() => post(`/purchasing/receipts/${id}/return`, {})} onDone={reload}>
            Return rejects to supplier
          </ActionButton>
        )}
      </>
    }>
      <Card>
        <KV rows={[
          ['Status', <Badge value={grn.status} />], ['Supplier', <Link href={`/parties/${grn.supplier_id}`}>{grn.supplier_name}</Link>],
          ['PO', <Link href={`/purchasing/orders/${grn.purchase_order_id}`}>{grn.po_no}</Link>], ['Received', dateTime(grn.received_at)], ['Notes', grn.notes],
        ]} />
      </Card>

      {grn.status === 'received' && can('grn:write') ? (
        <Card title="QC check">
          <p className="muted">Split each line into accepted and rejected. Accepted stock enters Stores at the PO rate; rejects are held in Rejected and cannot be sold.</p>
          <QcForm grn={grn} onDone={reload} />
        </Card>
      ) : (
        <Card title="Lines">
          <Table rows={grn.lines} columns={[
            { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
            { key: 'received_qty', title: 'Received', align: 'right', render: (r) => num(r.received_qty) },
            { key: 'accepted_qty', title: 'Accepted', align: 'right', render: (r) => num(r.accepted_qty) },
            { key: 'rejected_qty', title: 'Rejected', align: 'right', render: (r) => num(r.rejected_qty) },
            { key: 'reject_reason', title: 'Reject reason' },
            { key: 'returned_qty', title: 'Returned', align: 'right', render: (r) => num(r.returned_qty) },
            { key: 'rate', title: 'PO rate', align: 'right', render: (r) => inr(r.rate) },
            { key: 'qc_by_name', title: 'QC by' }, { key: 'qc_at', title: 'QC at', render: (r) => dateTime(r.qc_at) },
          ]} />
        </Card>
      )}

      {grn.returns.length > 0 && (
        <Card title="Supplier returns">
          <Table rows={grn.returns} columns={[
            { key: 'return_no', title: 'Return' }, { key: 'returned_at', title: 'When', render: (r) => dateTime(r.returned_at) },
            { key: 'debit_note_no', title: 'Debit note' },
            { key: 'debit_note_total', title: 'Debit note amount', align: 'right', render: (r) => inr(r.debit_note_total) },
          ]} />
        </Card>
      )}
    </Page>
  );
}

function QcForm({ grn, onDone }: { grn: any; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, { rejected: string; reason: string }>>(() =>
    Object.fromEntries(grn.lines.map((l: any) => [l.id, { rejected: '0', reason: '' }])));
  const [error, setError] = useState<string | null>(null);
  const set = (lineId: string, patch: Partial<{ rejected: string; reason: string }>) => setRows({ ...rows, [lineId]: { ...rows[lineId]!, ...patch } });
  return (
    <div>
      <Table rows={grn.lines} columns={[
        { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
        { key: 'received_qty', title: 'Received', align: 'right', render: (r) => num(r.received_qty) },
        { key: 'rej', title: 'Rejected', align: 'right', render: (r) => (
          <input type="number" min="0" max={Number(r.received_qty)} step="any" style={{ width: 90 }} value={rows[r.id]?.rejected ?? '0'} onChange={(e) => set(r.id, { rejected: e.target.value })} />
        ) },
        // Accepted is always received minus rejected, so the two can never fail to add up.
        { key: 'acc', title: 'Accepted', align: 'right', render: (r) => num(Math.max(0, sub(r.received_qty, rows[r.id]?.rejected || 0))) },
        { key: 'reason', title: 'Reject reason', render: (r) => (
          <input style={{ width: 240 }} disabled={!(Number(rows[r.id]?.rejected) > 0)} value={rows[r.id]?.reason ?? ''} onChange={(e) => set(r.id, { reason: e.target.value })} />
        ) },
      ]} />
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            await post(`/purchasing/receipts/${grn.id}/qc`, {
              lines: grn.lines.map((l: any) => {
                const rejected = Number(rows[l.id]?.rejected || 0);
                return { grn_line_id: l.id, rejected_qty: rejected, accepted_qty: sub(l.received_qty, rejected), reject_reason: rows[l.id]?.reason ?? '' };
              }),
            });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Save QC & inward to stock</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
