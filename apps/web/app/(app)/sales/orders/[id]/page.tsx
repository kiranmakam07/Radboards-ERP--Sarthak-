'use client';

import Link from 'next/link';
import { isTradeParty } from '@radcore/shared';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  ActionButton, Badge, Card, ErrorBox, KV, Loading, Page, PriceWarning, SmartButton, StatusBar, Table, Toggle, date, dateTime, inr, label, num, sub,
} from '@/components/ui';
import { EditLines, linesKey } from '@/components/edit-lines';
import { SerialPicker } from '@/components/serials';
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
  // The owner confirms an order to approve a price below cost or over a seller's discount limit.
  const approver = can('sales:approve_discount');
  const needsApproval = (o.price_problems ?? []).length > 0;
  const mayConfirm = o.status === 'draft' && (write || (approver && needsApproval));
  const pendingDelivery = o.lines.some((l: any) => Number(l.delivered_qty) < Number(l.qty));
  const pendingInvoice = o.lines.some((l: any) => Number(l.invoiced_qty) < Number(l.delivered_qty));
  const delivered = o.lines.some((l: any) => Number(l.delivered_qty) > 0);
  // Items kept by serial are delivered by naming the serials, in the delivery box below.
  const bySerial = o.lines.some((l: any) => l.is_serialised && Number(l.delivered_qty) < Number(l.qty));
  const invoices = o.invoices.filter((i: any) => i.status !== 'draft');
  const billed = invoices.filter((i: any) => i.status === 'issued').reduce((t: number, i: any) => t + (i.doc_type === 'credit_note' ? -1 : 1) * Number(i.grand_total), 0);

  return (
    <Page title={`${o.status === 'draft' ? 'Quote' : 'Order'} ${o.order_no}`}
      smart={
        <>
          <SmartButton icon="me" value={o.party?.name ?? 'Cash sale'} label={o.party ? label(o.party.party_type) : 'No party'} href={o.party ? `/parties/${o.party.id}` : null} />
          <SmartButton icon="stores" value={o.deliveries.length} label="Deliveries" href={o.deliveries.length ? '#deliveries' : null} />
          <SmartButton icon="accounts" value={invoices.length} label={invoices.length ? `Invoices · ₹${inr(billed).replace(/\.00$/, '')}` : 'Invoices'} href={invoices.length ? '#invoices' : null} />
          {o.lead_id ? <SmartButton icon="crm" value="Lead" label="Where it came from" href={`/leads/${o.lead_id}`} /> : null}
        </>
      }
      status={
        <StatusBar steps={['Quote', 'Confirmed', 'Delivered', 'Invoiced']}
          current={{ draft: 0, confirmed: 1, delivered: 2, invoiced: 3 }[o.status as string] ?? 0}
          stopped={o.status === 'cancelled' ? 'Cancelled' : null} />
      }
      actions={
      <>
        {mayConfirm && (
          <>
            <ActionButton kind="primary" onClick={() => post(`/sales/orders/${id}/confirm`, {})} onDone={reload}
              confirm={needsApproval && approver ? 'Approve these prices and confirm the order? The approval is logged.' : undefined}>
              {needsApproval && approver ? 'Approve prices & confirm' : 'Confirm order'}
            </ActionButton>
            {can('sales:override_credit') && (
              <ActionButton confirm="Confirm this order even though it is over the dealer's credit limit?" onClick={() => post(`/sales/orders/${id}/confirm`, { override_credit: true })} onDone={reload}>Confirm (override credit limit)</ActionButton>
            )}
          </>
        )}
        {write && o.status === 'confirmed' && pendingDelivery && !bySerial && (
          <ActionButton kind="primary" confirm="Deliver everything still pending? Stock will be deducted." onClick={() => post(`/sales/orders/${id}/deliver`, {})} onDone={reload}>Deliver all pending</ActionButton>
        )}
        {write && pendingInvoice && ['confirmed', 'delivered'].includes(o.status) && (
          <ActionButton kind="primary" onClick={() => post(`/sales/orders/${id}/invoice`, {})} onDone={reload}>Invoice delivered goods</ActionButton>
        )}
        <Link className="button" href={`/sales/orders/${id}/print`}>Print {o.status === 'draft' ? 'quotation' : 'order'}</Link>
        {write && ['draft', 'confirmed'].includes(o.status) && !delivered && (
          <ActionButton kind="danger" confirm="Cancel this order?" onClick={() => post(`/sales/orders/${id}/cancel`, { reason: 'Cancelled by user' })} onDone={reload}>Cancel</ActionButton>
        )}
      </>
    }>
      {o.status === 'draft' ? <PriceWarning problems={o.price_problems} canApprove={approver} approves="Confirming the order" ask="confirm this order" /> : null}
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
          {Number(o.totals.cess_total) > 0 && <div><span>Cess</span><span>{inr(o.totals.cess_total)}</span></div>}
          {Number(o.totals.round_off) !== 0 && <div><span>Round off</span><span>{inr(o.totals.round_off)}</span></div>}
          <div className="grand"><span>Total</span><span>₹{inr(o.totals.grand_total)}</span></div>
        </div>
      </Card>

      {write && o.status === 'draft' && (
        <EditLines key={linesKey(o.lines)} path={`/sales/orders/${id}/lines`} lines={o.lines} onDone={reload}
          priceKey={isTradeParty(o.party?.party_type) ? 'dealer_price' : 'retail_price'} filter={(i) => i.item_type !== 'raw_material'} />
      )}
      {write && o.status === 'confirmed' && pendingDelivery && (
        bySerial
          ? <Card title="Deliver: pick the serials"><PartialDelivery order={o} onDone={reload} /></Card>
          : <Toggle label="Deliver part of the order"><PartialDelivery order={o} onDone={reload} /></Toggle>
      )}

      {o.reservations.length > 0 || (write && ['draft', 'confirmed'].includes(o.status) && pendingDelivery) ? (
        <Card title="Stock held for this order" id="held">
          <Table rows={o.reservations} empty="Nothing held yet. Holding stock keeps it from being sold to anyone else." columns={[
            { key: 'item_name', title: 'Item', render: (r) => <>{r.item_name}{r.serial_no ? <span className="muted small"> · {r.serial_no}</span> : null}</> },
            { key: 'qty', title: 'Qty', align: 'right', render: (r) => num(r.qty) },
            { key: 'location', title: 'At' },
            { key: 'expires_on', title: 'Held until', render: (r) => (r.expires_on ? date(r.expires_on) : 'Delivered') },
            { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
            { key: 'x', title: '', render: (r) => (write && r.status === 'open' ? (
              <ActionButton confirm="Let this stock go? Anyone can then sell it." onClick={() => post(`/sales/reservations/${r.id}/release`, {})} onDone={reload}>Let go</ActionButton>
            ) : null) },
          ]} />
          {write && ['draft', 'confirmed'].includes(o.status) && pendingDelivery ? (
            <Toggle label="Hold stock for this order"><HoldStock order={o} onDone={reload} /></Toggle>
          ) : null}
        </Card>
      ) : null}

      <div className="grid no-print">
        <Card title="Deliveries" id="deliveries">
          <Table rows={o.deliveries} empty="Nothing delivered yet." rowHref={(r) => `/sales/deliveries/${r.id}`} columns={[
            { key: 'delivery_no', title: 'Challan' }, { key: 'delivered_at', title: 'When', render: (r) => dateTime(r.delivered_at) }, { key: 'location', title: 'From' },
          ]} />
        </Card>
        <Card title="Invoices" id="invoices">
          <Table rows={invoices} empty="Not invoiced yet." rowHref={(r) => `/invoices/${r.id}`} columns={[
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
  const [serials, setSerials] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = order.lines.filter((l: any) => Number(l.delivered_qty) < Number(l.qty));
  // Goods leave from the showroom for a counter order, from stores for any other, unless another place is picked.
  const places = useGet<{ data: { id: string; name: string; type: string; active: boolean }[] }>('/masters/locations');
  const sellFrom = (places.data?.data ?? []).filter((l) => l.active && ['stores', 'showroom', 'demo', 'franchise'].includes(l.type));
  const [picked, setPicked] = useState('');
  const from = picked || sellFrom.find((l) => l.type === (order.channel === 'store' ? 'showroom' : 'stores'))?.id || null;
  return (
    <div>
      <div className="form" style={{ marginBottom: 8 }}>
        <label><span>Deliver from</span>
          <select value={from ?? ''} onChange={(e) => { setPicked(e.target.value); setSerials({}); }}>
            {sellFrom.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      <Table rows={pending} columns={[
        { key: 'item_name', title: 'Item', render: (r) => (
          <>
            {r.item_name}
            {r.is_serialised ? (
              <SerialPicker itemId={r.item_id} locationId={from} qty={Number(qty[r.id] || 0)} value={serials[r.id] ?? []}
                onChange={(s) => { setSerials({ ...serials, [r.id]: s }); setQty({ ...qty, [r.id]: String(s.length) }); }} />
            ) : null}
          </>
        ) },
        { key: 'pending', title: 'Pending', align: 'right', render: (r) => num(sub(r.qty, r.delivered_qty)) },
        { key: 'now', title: 'Deliver now', align: 'right', render: (r) => (
          <input type="number" min="0" step="any" style={{ width: 90 }} value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />
        ) },
      ]} />
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            const lines = Object.entries(qty).filter(([, q]) => Number(q) > 0)
              .map(([order_line_id, q]) => ({ order_line_id, qty: q, ...(serials[order_line_id]?.length ? { serials: serials[order_line_id] } : {}) }));
            await post(`/sales/orders/${order.id}/deliver`, { lines, location_id: from });
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

/** Hold stock for the order (a booking): how much of each line, where, until when; serials for items kept by serial. */
function HoldStock({ order, onDone }: { order: any; onDone: () => void }) {
  const places = useGet<{ data: { id: string; name: string; type: string; active: boolean }[] }>('/masters/locations');
  const sellFrom = (places.data?.data ?? []).filter((l) => l.active && ['stores', 'showroom', 'demo', 'franchise'].includes(l.type));
  const fallback = sellFrom.find((l) => l.type === (order.channel === 'store' ? 'showroom' : 'stores'))?.id ?? '';
  const [where, setWhere] = useState('');
  const [until, setUntil] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const at = where || fallback;
  const open = order.lines.filter((l: any) => Number(l.delivered_qty) < Number(l.qty));
  return (
    <div>
      <div className="form">
        <label><span>Held at</span><select value={at} onChange={(e) => setWhere(e.target.value)}>{sellFrom.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label><span>Held until</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /><small className="muted">Empty: until it is delivered</small></label>
      </div>
      <Table rows={open} columns={[
        { key: 'item_name', title: 'Item', render: (r) => (
          <>
            {r.item_name}
            {r.is_serialised ? <SerialPicker itemId={r.item_id} locationId={at || null} qty={Number(qty[r.id] || 0)} value={serials[r.id] ?? []}
              onChange={(s) => { setSerials({ ...serials, [r.id]: s }); setQty({ ...qty, [r.id]: String(s.length) }); }} /> : null}
          </>
        ) },
        { key: 'pending', title: 'Still to deliver', align: 'right', render: (r) => num(sub(r.qty, r.delivered_qty)) },
        { key: 'hold', title: 'Hold', align: 'right', render: (r) => (
          <input type="number" min="0" step="any" style={{ width: 90 }} value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />
        ) },
      ]} />
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            const lines = Object.entries(qty).filter(([, q]) => Number(q) > 0)
              .map(([order_line_id, q]) => ({ order_line_id, qty: q, location_id: at, ...(serials[order_line_id]?.length ? { serials: serials[order_line_id] } : {}) }));
            await post(`/sales/orders/${order.id}/reservations`, { lines, expires_on: until || null });
            setQty({}); setSerials({});
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Hold</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
