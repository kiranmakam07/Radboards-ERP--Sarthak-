'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES } from '@radcore/shared';
import { Loading, Page, addr, date, num } from '@/components/ui';
import { useGet } from '@/lib/api';

/** Delivery challan: the paper that travels with a dispatch (PRD 7.11). Quantities only, no prices. */
export default function DeliveryChallanPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useGet<{ data: any }>(`/sales/deliveries/${id}`);
  const d = data?.data;
  if (!d) return <Page title="Delivery challan"><Loading loading={loading} error={error} /></Page>;
  const c = d.company;
  const shipTo = addr(d.shipping_address) || addr(d.billing_address);
  const waPhone = String(d.party_phone ?? '').replace(/\D/g, '');
  const waText = `${c.name}\nDelivery challan ${d.delivery_no} dated ${date(d.delivered_at)} for order ${d.order_no}\n${d.lines.map((l: any) => `${l.item_name} x ${num(l.qty)} ${l.unit}`).join('\n')}`;

  return (
    <Page title={`Delivery challan ${d.delivery_no}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {waPhone && <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`}>Share on WhatsApp</a>}
        <Link className="button" href={`/sales/orders/${d.order_id}`}>Order {d.order_no}</Link>
      </>
    }>
      <div className="doc">
        <h1>DELIVERY CHALLAN</h1>
        <div className="head">
          <div>
            <strong>{c.name}</strong><br />
            {addr(c.address)}<br />
            {c.gstin && <>GSTIN: {c.gstin}<br /></>}
            State: {STATE_CODES[c.state_code]} ({c.state_code})
            {c.phone && <><br />Phone: {c.phone}</>}
          </div>
          <div>
            <strong>Challan no:</strong> {d.delivery_no}<br />
            <strong>Date:</strong> {date(d.delivered_at)}<br />
            <strong>Order no:</strong> {d.order_no}<br />
            <strong>Dispatched from:</strong> {d.location}
          </div>
        </div>
        <div className="head">
          <div>
            <strong>Deliver to</strong><br />
            {d.party_name ?? 'Cash sale'}<br />
            {shipTo}{shipTo && <br />}
            {d.party_phone && <>Phone: {d.party_phone}<br /></>}
            {d.party_gstin && <>GSTIN: {d.party_gstin}</>}
          </div>
        </div>
        <table>
          <thead><tr><th>#</th><th>Item</th><th>SKU</th><th>HSN/SAC</th><th className="right">Quantity</th></tr></thead>
          <tbody>
            {d.lines.map((l: any, i: number) => (
              <tr key={l.id}><td>{i + 1}</td><td>{l.item_name}</td><td>{l.sku}</td><td>{l.hsn_sac}</td><td className="right">{num(l.qty)} {l.unit}</td></tr>
            ))}
          </tbody>
        </table>
        {d.notes && <p className="small">Notes: {d.notes}</p>}
        <div className="head" style={{ marginTop: 48 }}>
          <div>Received the above goods in good condition.<br /><br /><br />Name, signature and date of the receiver</div>
          <div style={{ textAlign: 'right' }}>For {c.name}<br /><br /><br />Authorised signatory</div>
        </div>
      </div>
    </Page>
  );
}
