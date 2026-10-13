'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ActionButton, Badge, Card, KV, Loading, Page, Table, date, inr, label, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const MISMATCH: Record<string, string> = {
  rate_vs_po: 'Rate differs from the PO',
  qty_billed_over_po: 'Billed more than was ordered',
  qty_billed_vs_received: 'Billed quantity differs from what was received',
};

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/purchasing/bills/${id}`);
  const b = data?.data;
  if (!b) return <Page title="Purchase bill"><Loading loading={loading} error={error} /></Page>;
  const isDn = b.doc_type === 'debit_note';

  return (
    <Page title={`${isDn ? 'Debit note' : 'Purchase bill'} ${b.bill_no}`} actions={
      <>
        <button type="button" onClick={() => window.print()}>Print / PDF</button>
        {!isDn && b.status === 'posted' && can('payments:write') && Number(b.outstanding) > 0 && <Link className="button primary" href={`/payments?party_id=${b.supplier_id}`}>Pay supplier</Link>}
        {!isDn && b.status === 'posted' && can('bills:write') && (
          <ActionButton kind="danger" confirm="Cancel this bill? Its accounting entries will be reversed." onClick={() => post(`/purchasing/bills/${id}/cancel`, { reason: 'Entered in error' })} onDone={reload}>Cancel bill</ActionButton>
        )}
      </>
    }>
      <Card>
        <KV rows={[
          ['Status', b.status === 'cancelled' ? <Badge value="cancelled" /> : isDn ? <Badge value="posted" /> : <Badge value={b.payment_status} />],
          ['Supplier', <Link href={`/parties/${b.supplier_id}`}>{b.supplier_name}</Link>], ['Supplier GSTIN', b.supplier_gstin],
          ['Job work challan', b.job_work_id ? <><Link href={`/jobwork/${b.job_work_id}`}>{b.job_work_challan_no}</Link>{Number(b.job_work_cleared) ? <span className="muted small"> · ₹{inr(b.job_work_cleared)} of this was already in the cost of the goods</span> : null}</> : null],
          ['Supplier invoice no', b.supplier_invoice_no], ['Date', date(b.bill_date)], ['Due', date(b.due_date)],
          ['PO', b.purchase_order_id ? <Link href={`/purchasing/orders/${b.purchase_order_id}`}>{b.po_no}</Link> : null],
          ['Outstanding', !isDn && b.outstanding !== null ? `₹${inr(b.outstanding)}` : null], ['Notes', b.notes],
        ]} />
      </Card>

      {b.mismatches?.length > 0 && (
        <Card title="Check before paying">
          {b.mismatches.map((m: any, i: number) => (
            <div key={i} className="error" style={{ marginBottom: 6 }}>
              {m.item}: {MISMATCH[m.type] ?? label(m.type)} — expected {m.expected}, bill says {m.actual}
            </div>
          ))}
        </Card>
      )}

      <Card title="Lines">
        <Table rows={b.lines} columns={[
          { key: 'description', title: 'Item', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.sku} — {r.description}</span> }, { key: 'hsn_sac', title: 'HSN' },
          { key: 'qty', title: 'Qty', align: 'right', render: (r) => `${num(r.qty)} ${r.unit}` },
          { key: 'rate', title: 'Rate', align: 'right', render: (r) => inr(r.rate) },
          { key: 'taxable_value', title: 'Taxable', align: 'right', render: (r) => inr(r.taxable_value) },
          { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => num(r.gst_rate) },
          { key: 'line_total', title: 'Amount', align: 'right', render: (r) => inr(r.line_total) },
        ]} />
        <div className="totals" style={{ marginTop: 10 }}>
          <div><span>Taxable value</span><span>{inr(b.taxable_total)}</span></div>
          {Number(b.cgst_total) > 0 && <div><span>Input CGST</span><span>{inr(b.cgst_total)}</span></div>}
          {Number(b.sgst_total) > 0 && <div><span>Input SGST</span><span>{inr(b.sgst_total)}</span></div>}
          {Number(b.igst_total) > 0 && <div><span>Input IGST</span><span>{inr(b.igst_total)}</span></div>}
          {Number(b.round_off) !== 0 && <div><span>Round off</span><span>{inr(b.round_off)}</span></div>}
          <div className="grand"><span>Total</span><span>₹{inr(b.grand_total)}</span></div>
        </div>
      </Card>

      <div className="grid no-print">
        {b.payments.length > 0 && (
          <Card title="Payments made">
            <Table rows={b.payments} columns={[
              { key: 'payment_no', title: 'Payment' }, { key: 'paid_on', title: 'Date', render: (r) => date(r.paid_on) }, { key: 'mode', title: 'Mode', render: (r) => label(r.mode) },
              { key: 'reference', title: 'Reference' }, { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            ]} />
          </Card>
        )}
        {b.debit_notes.length > 0 && (
          <Card title="Debit notes">
            <Table rows={b.debit_notes} rowHref={(r) => `/purchasing/bills/${r.id}`} columns={[
              { key: 'bill_no', title: 'Number' }, { key: 'bill_date', title: 'Date', render: (r) => date(r.bill_date) },
              { key: 'grand_total', title: 'Amount', align: 'right', render: (r) => inr(r.grand_total) },
            ]} />
          </Card>
        )}
      </div>
    </Page>
  );
}
