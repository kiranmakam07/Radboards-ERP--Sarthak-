'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, KV, Loading, Page, Table, Toggle, date, dateTime, inr, label, num, sub } from '@/components/ui';
import { Steps } from '@/components/charts';
import { EditLines } from '@/components/edit-lines';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Draft (quote) -> Confirmed -> Delivered (partial allowed) -> Invoiced, or Cancelled before delivery. */
export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/sales/orders/${id}`);
  const o = data?.data;
  if (!o) return <Page title="Order"><Loading loading={loading} error={error} /></Page>;
  const write = can('sales:write');
  const pendingDelivery = o.lines.some((l: any) => Number(l.delivered_qty) < Number(l.qty));
  const pendingInvoice = o.lines.some((l: any) => Number(l.invoiced_qty) < Number(l.delivered_qty));
  const delivered = o.lines.some((l: any) => Number(l.delivered_qty) > 0);

  return (
    <Page title={`${o.status === 'draft' ? 'Quote' : 'Order'} ${o.order_no}`} actions={
      <>
        <Link className="button" href={`/sales/orders/${id}/print`}>Print {o.status === 'draft' ? 'quotation' : 'order'}</Link>
        {write && o.status === 'draft' && (
          <>
            <ActionButton kind="primary" onClick={() => post(`/sales/orders/${id}/confirm`, {})} onDone={reload}>Confirm order</ActionButton>
            {can('sales:override_credit') && (
              <ActionButton confirm="Confirm this order even though it is over the dealer's credit limit?" onClick={() => post(`/sales/orders/${id}/confirm`, { override_credit: true })} onDone={reload}>Confirm (override credit limit)</ActionButton>
            )}
          </>
        )}
        {write && o.status === 'confirmed' && pendingDelivery && (
          <ActionButton kind="primary" confirm="Deliver everything still pending? Stock will be deducted." onClick={() => post(`/sales/orders/${id}/deliver`, {})} onDone={reload}>Deliver all pending</ActionButton>
        )}
        {write && pendingInvoice && ['confirmed', 'delivered'].includes(o.status) && (
          <ActionButton kind="primary" onClick={() => post(`/sales/orders/${id}/invoice`, {})} onDone={reload}>Invoice delivered goods</ActionButton>
        )}
        {write && ['draft', 'confirmed'].includes(o.status) && !delivered && (
          <ActionButton kind="danger" confirm="Cancel this order?" onClick={() => post(`/sales/orders/${id}/cancel`, { reason: 'Cancelled by user' })} onDone={reload}>Cancel</ActionButton>
        )}
      </>
    }>
      <Steps steps={['Quote', 'Confirmed', 'Delivered', 'Invoiced']}
        current={{ draft: 0, confirmed: 1, delivered: 2, invoiced: 4 }[o.status as string] ?? 0}
        stopped={o.status === 'cancelled' ? 'Cancelled' : null} />
      <Card>
        <KV rows={[
          ['Status', <Badge value={o.status} />],
          ['Party', o.party ? <Link href={`/parties/${o.party.id}`}>{o.party.name}</Link> : 'Cash sale'],
          ['GSTIN', o.party?.gstin], ['Channel', label(o.channel)], ['Date', date(o.order_date)],
          ['Place of supply', o.place_of_supply], ['Prices', o.tax_inclusive ? 'Include GST' : 'Exclude GST'], ['Notes', o.notes],
        ]} />
      </Card>

      <Card title="Items">
        <Table rows={o.lines} columns={[
          { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
          { key: 'hsn_sac', title: 'HSN' },
          { key: 'qty', title: 'Qty', align: 'right', render: (r) => `${num(r.qty)} ${r.unit}` },
          { key: 'rate', title: 'Rate', align: 'right', render: (r) => inr(r.rate) },
          { key: 'discount', title: 'Discount', align: 'right', render: (r) => (Number(r.discount) ? inr(r.discount) : '') },
          { key: 'taxable_value', title: 'Taxable', align: 'right', render: (r) => inr(r.taxable_value) },
          { key: 'gst_rate', title: 'GST %', align: 'right', render: (r) => num(r.gst_rate) },
          { key: 'line_total', title: 'Amount', align: 'right', render: (r) => inr(r.line_total) },
          { key: 'delivered_qty', title: 'Delivered', align: 'right', render: (r) => num(r.delivered_qty) },
          { key: 'invoiced_qty', title: 'Invoiced', align: 'right', render: (r) => num(r.invoiced_qty) },
        ]} />
        <div className="totals" style={{ marginTop: 10 }}>
          <div><span>Taxable value</span><span>{inr(o.totals.taxable_total)}</span></div>
          {Number(o.totals.igst_total) > 0 && <div><span>IGST</span><span>{inr(o.totals.igst_total)}</span></div>}
          {Number(o.totals.cgst_total) > 0 && <div><span>CGST</span><span>{inr(o.totals.cgst_total)}</span></div>}
          {Number(o.totals.sgst_total) > 0 && <div><span>SGST</span><span>{inr(o.totals.sgst_total)}</span></div>}
          {Number(o.totals.round_off) !== 0 && <div><span>Round off</span><span>{inr(o.totals.round_off)}</span></div>}
          <div className="grand"><span>Total</span><span>₹{inr(o.totals.grand_total)}</span></div>
        </div>
      </Card>

      {write && o.status === 'draft' && (
        <EditLines key={o.lines.map((l: any) => l.id).join()} path={`/sales/orders/${id}/lines`} lines={o.lines} onDone={reload}
          priceKey={o.party?.party_type === 'dealer' ? 'dealer_price' : 'retail_price'} filter={(i) => i.item_type !== 'raw_material'} />
      )}
      {write && o.status === 'confirmed' && pendingDelivery && (
        <Toggle label="Deliver part of the order"><PartialDelivery order={o} onDone={reload} /></Toggle>
      )}

      <div className="grid no-print">
        <Card title="Deliveries">
          <Table rows={o.deliveries} empty="Nothing delivered yet." rowHref={(r) => `/sales/deliveries/${r.id}`} columns={[
            { key: 'delivery_no', title: 'Challan' }, { key: 'delivered_at', title: 'When', render: (r) => dateTime(r.delivered_at) }, { key: 'location', title: 'From' },
          ]} />
        </Card>
        <Card title="Invoices">
          <Table rows={o.invoices.filter((i: any) => i.status !== 'draft')} empty="Not invoiced yet." rowHref={(r) => `/invoices/${r.id}`} columns={[
            { key: 'invoice_no', title: 'Number' }, { key: 'doc_type', title: 'Type', render: (r) => (r.doc_type === 'credit_note' ? 'Credit note' : 'Invoice') },
            { key: 'invoice_date', title: 'Date', render: (r) => date(r.invoice_date) },
            { key: 'grand_total', title: 'Total', align: 'right', render: (r) => inr(r.grand_total) }, { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
          ]} />
        </Card>
      </div>
    </Page>
  );
}

function PartialDelivery({ order, onDone }: { order: any; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = order.lines.filter((l: any) => Number(l.delivered_qty) < Number(l.qty));
  return (
    <div>
      <Table rows={pending} columns={[
        { key: 'item_name', title: 'Item' },
        { key: 'pending', title: 'Pending', align: 'right', render: (r) => num(sub(r.qty, r.delivered_qty)) },
        { key: 'now', title: 'Deliver now', align: 'right', render: (r) => (
          <input type="number" min="0" step="any" style={{ width: 90 }} value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />
        ) },
      ]} />
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            const lines = Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([order_line_id, q]) => ({ order_line_id, qty: q }));
            await post(`/sales/orders/${order.id}/deliver`, { lines });
            setQty({});
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Deliver</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
