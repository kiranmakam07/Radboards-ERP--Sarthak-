'use client';

import { istDate } from '@radcore/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, KV, Loading, Page, Table, Toggle, date, dateTime, inr, num, sub } from '@/components/ui';
import { Steps } from '@/components/charts';
import { EditLines, linesKey } from '@/components/edit-lines';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** PO -> supplier invoice -> goods inward. No indents, no approval chain (PRD 7.7). */
export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/purchasing/orders/${id}`);
  const po = data?.data;
  if (!po) return <Page title="Purchase order"><Loading loading={loading} error={error} /></Page>;
  const open = ['sent', 'partly_received'].includes(po.status);
  const waText = `Purchase order ${po.po_no} from ${po.company.name}\n${po.lines.map((l: any) => `${l.item_name} x ${num(l.qty)} @ Rs ${inr(l.rate)}`).join('\n')}`;
  const waPhone = String(po.supplier_phone ?? '').replace(/\D/g, '');

  return (
    <Page title={`PO ${po.po_no}`} actions={
      <>
        <Link className="button" href={`/purchasing/orders/${id}/print`}>Print / PDF</Link>
        {waPhone && <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`}>Share on WhatsApp</a>}
        {can('po:write') && po.status === 'draft' && <ActionButton kind="primary" onClick={() => post(`/purchasing/orders/${id}/send`)} onDone={reload}>Mark as sent</ActionButton>}
        {can('po:write') && ['draft', 'sent'].includes(po.status) && <ActionButton kind="danger" confirm="Cancel this PO?" onClick={() => post(`/purchasing/orders/${id}/cancel`)} onDone={reload}>Cancel</ActionButton>}
        {can('po:write') && ['partly_received', 'received'].includes(po.status) && <ActionButton confirm="Close this PO? Nothing more can be received against it." onClick={() => post(`/purchasing/orders/${id}/close`)} onDone={reload}>Close PO</ActionButton>}
      </>
    }>
      <Steps steps={['Draft', 'Sent to supplier', 'Goods arriving', 'All received']}
        current={{ draft: 0, sent: 1, partly_received: 2, received: 4, closed: 4 }[po.status as string] ?? 0}
        stopped={po.status === 'cancelled' ? 'Cancelled' : null} />
      <Card>
        <KV rows={[
          ['Status', <Badge value={po.status} />], ['Supplier', <Link href={`/parties/${po.supplier_id}`}>{po.supplier_name}</Link>],
          ['Supplier GSTIN', po.supplier_gstin], ['Order date', date(po.order_date)], ['Expected', date(po.expected_date)], ['Notes', po.notes],
        ]} />
      </Card>
      <Card title="Items">
        <Table rows={po.lines} columns={[
          { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` }, { key: 'hsn_sac', title: 'HSN' },
          { key: 'qty', title: 'Ordered', align: 'right', render: (r) => `${num(r.qty)} ${r.unit}` },
          { key: 'rate', title: 'Rate', align: 'right', render: (r) => inr(r.rate) },
          { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => num(r.gst_rate) },
          { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
          { key: 'received_qty', title: 'Received', align: 'right', render: (r) => num(r.received_qty) },
          { key: 'billed_qty', title: 'Billed', align: 'right', render: (r) => num(r.billed_qty) },
        ]} />
      </Card>

      <div className="no-print">
        {can('po:write') && po.status === 'draft' && (
          <EditLines key={linesKey(po.lines)} path={`/purchasing/orders/${id}/lines`} lines={po.lines}
            priceKey="purchase_cost" withDiscount={false} onDone={reload} />
        )}
        {can('grn:write') && open && (
          <Toggle label="Receive goods (inward)">
            <LinesForm lines={po.lines.filter((l: any) => Number(l.received_qty) < Number(l.qty))} qtyTitle="Received now" withRate={false}
              defaultQty={(l) => String(sub(l.qty, l.received_qty))} submit="Save receipt (goes to QC)"
              onSubmit={async (rows) => {
                const res = await post('/purchasing/receipts', { purchase_order_id: id, lines: rows.map((r) => ({ po_line_id: r.id, received_qty: r.qty })) });
                router.push(`/purchasing/receipts/${res.data.id}`);
              }} />
          </Toggle>
        )}
        {can('bills:write') && !['draft', 'cancelled'].includes(po.status) && (
          <Toggle label="Record supplier invoice (bill)">
            <BillForm po={po} onDone={(bill) => router.push(`/purchasing/bills/${bill.id}`)} />
          </Toggle>
        )}
        <div className="grid">
          <Card title="Goods receipts">
            <Table rows={po.receipts} empty="Nothing received yet." rowHref={(r) => `/purchasing/receipts/${r.id}`} columns={[
              { key: 'grn_no', title: 'GRN' }, { key: 'received_at', title: 'Received', render: (r) => dateTime(r.received_at) },
              { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
            ]} />
          </Card>
          <Card title="Bills & debit notes">
            <Table rows={po.bills} empty="No supplier invoice recorded yet." rowHref={(r) => `/purchasing/bills/${r.id}`} columns={[
              { key: 'bill_no', title: 'Number' }, { key: 'supplier_invoice_no', title: 'Supplier inv.' },
              { key: 'bill_date', title: 'Date', render: (r) => date(r.bill_date) },
              { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) },
              { key: 'mismatches', title: '', render: (r) => (r.mismatches?.length ? <Badge value="rejected" /> : null) },
            ]} />
          </Card>
        </div>
      </div>
    </Page>
  );
}

type RowIn = { id: string; qty: string; rate: string };

function LinesForm({
  lines, qtyTitle, withRate, defaultQty, submit, onSubmit,
}: {
  lines: any[]; qtyTitle: string; withRate: boolean; defaultQty: (l: any) => string; submit: string; onSubmit: (rows: RowIn[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<Record<string, { qty: string; rate: string }>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, { qty: defaultQty(l), rate: String(Number(l.rate)) }])));
  const [error, setError] = useState<string | null>(null);
  const set = (lineId: string, patch: Partial<{ qty: string; rate: string }>) => setRows({ ...rows, [lineId]: { ...rows[lineId]!, ...patch } });
  return (
    <div>
      <Table rows={lines} columns={[
        { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
        { key: 'qty', title: 'Ordered', align: 'right', render: (r) => num(r.qty) },
        { key: 'now', title: qtyTitle, align: 'right', render: (r) => (
          <input type="number" min="0" step="any" style={{ width: 90 }} value={rows[r.id]?.qty ?? ''} onChange={(e) => set(r.id, { qty: e.target.value })} />
        ) },
        ...(withRate ? [{ key: 'rate_in', title: 'Rate on bill', align: 'right' as const, render: (r: any) => (
          <input type="number" min="0" step="any" style={{ width: 110 }} value={rows[r.id]?.rate ?? ''} onChange={(e) => set(r.id, { rate: e.target.value })} />
        ) }] : []),
      ]} />
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            await onSubmit(Object.entries(rows).filter(([, v]) => Number(v.qty) > 0).map(([lineId, v]) => ({ id: lineId, ...v })));
          } catch (e) {
            setError((e as Error).message);
          }
        }}>{submit}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

function BillForm({ po, onDone }: { po: any; onDone: (bill: any) => void }) {
  const [head, setHead] = useState({ supplier_invoice_no: '', bill_date: istDate(), round_off: '' });
  return (
    <div>
      <div className="form" style={{ marginBottom: 10 }}>
        <label><span>Supplier invoice no *</span><input value={head.supplier_invoice_no} onChange={(e) => setHead({ ...head, supplier_invoice_no: e.target.value })} /></label>
        <label><span>Invoice date *</span><input type="date" value={head.bill_date} onChange={(e) => setHead({ ...head, bill_date: e.target.value })} /></label>
        <label><span>Round off on bill (+/-)</span><input type="number" step="any" value={head.round_off} onChange={(e) => setHead({ ...head, round_off: e.target.value })} /></label>
      </div>
      <LinesForm lines={po.lines.filter((l: any) => Number(l.billed_qty) < Number(l.qty))} qtyTitle="Qty on bill" withRate
        defaultQty={(l) => String(sub(l.qty, l.billed_qty))} submit="Save bill"
        onSubmit={async (rows) => {
          const res = await post('/purchasing/bills', {
            supplier_id: po.supplier_id, purchase_order_id: po.id, ...head,
            lines: rows.map((r) => ({ po_line_id: r.id, qty: r.qty, rate: r.rate })),
          });
          onDone(res.data);
        }} />
    </div>
  );
}
