'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES, amountInWords } from '@radcore/shared';
import { Loading, Page, addr, date, inr, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const paise = (v: number) => Math.round(v * 100) / 100;

/** The purchase order as a document to send to the supplier (PRD 7.11). */
export default function PurchaseOrderPrintPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useGet<{ data: any }>(`/purchasing/orders/${id}`);
  const po = data?.data;
  if (!po) return <Page title="Purchase order"><Loading loading={loading} error={error} /></Page>;
  const c = po.company;
  // GST by the usual rule: the supplier's state against ours.
  const interState = Boolean(po.supplier_state_code) && po.supplier_state_code !== c.state_code;
  const taxable = paise(po.lines.reduce((s: number, l: any) => s + Number(l.amount), 0));
  const tax = paise(po.lines.reduce((s: number, l: any) => s + (Number(l.amount) * Number(l.gst_rate)) / 100, 0));
  const total = paise(taxable + tax);
  const waPhone = String(po.supplier_phone ?? '').replace(/\D/g, '');
  const waText = `${c.name}\nPurchase order ${po.po_no} dated ${date(po.order_date)}\n${po.lines.map((l: any) => `${l.item_name} x ${num(l.qty)} ${l.unit} @ ${inr(l.rate)}`).join('\n')}`;

  return (
    <Page title={`Purchase order ${po.po_no}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {waPhone && <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`}>Share on WhatsApp</a>}
        <Link className="button" href={`/purchasing/orders/${id}`}>Back to the order</Link>
      </>
    }>
      <div className="doc">
        <h1>PURCHASE ORDER</h1>
        <div className="head">
          <div>
            <strong>{c.name}</strong><br />
            {addr(c.address)}<br />
            {c.gstin && <>GSTIN: {c.gstin}<br /></>}
            State: {STATE_CODES[c.state_code]} ({c.state_code})
            {c.phone && <><br />Phone: {c.phone}</>}
          </div>
          <div>
            <strong>Order no:</strong> {po.po_no}<br />
            <strong>Date:</strong> {date(po.order_date)}<br />
            {po.expected_date && <><strong>Needed by:</strong> {date(po.expected_date)}</>}
          </div>
        </div>
        <div className="head">
          <div>
            <strong>To</strong><br />
            {po.supplier_name}<br />
            {addr(po.supplier_address)}{addr(po.supplier_address) && <br />}
            {po.supplier_phone && <>Phone: {po.supplier_phone}<br /></>}
            {po.supplier_gstin && <>GSTIN: {po.supplier_gstin}</>}
          </div>
          <div>
            <strong>Deliver to</strong><br />
            {c.name}<br />
            {addr(c.address)}
          </div>
        </div>
        <table>
          <thead>
            <tr><th>#</th><th>Item</th><th>SKU</th><th>HSN/SAC</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">GST</th><th className="right">Amount</th></tr>
          </thead>
          <tbody>
            {po.lines.map((l: any, i: number) => (
              <tr key={l.id}>
                <td>{i + 1}</td><td>{l.item_name}</td><td>{l.sku}</td><td>{l.hsn_sac}</td><td className="right">{num(l.qty)} {l.unit}</td>
                <td className="right">{inr(l.rate)}</td><td className="right">{num(l.gst_rate)}%</td><td className="right">{inr(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={7} className="right">Value before GST</td><td className="right">{inr(taxable)}</td></tr>
            <tr><td colSpan={7} className="right">{interState ? 'IGST' : 'CGST + SGST'} (estimate)</td><td className="right">{inr(tax)}</td></tr>
            <tr><td colSpan={7} className="right"><strong>Total (estimate)</strong></td><td className="right"><strong>₹{inr(total)}</strong></td></tr>
          </tfoot>
        </table>
        <p className="words">{amountInWords(total)}</p>
        {po.notes && <p className="small">Notes: {po.notes}</p>}
        <p className="small">Please quote this order number on your invoice and delivery challan. GST is as it will appear on your tax invoice; the figures here are our estimate.</p>
        <div className="sign">For {c.name}<br /><br /><br />Authorised signatory</div>
      </div>
    </Page>
  );
}
