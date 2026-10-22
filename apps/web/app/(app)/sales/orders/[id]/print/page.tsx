'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES, amountInWords } from '@radcore/shared';
import { Loading, Page, addr, date, inr, num } from '@/components/ui';
import { useGet } from '@/lib/api';

/** The quotation, or the order confirmation once the quote is accepted, as a document to print or send (PRD 7.11). */
export default function OrderPrintPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useGet<{ data: any }>(`/sales/orders/${id}`);
  const o = data?.data;
  if (!o) return <Page title="Quotation"><Loading loading={loading} error={error} /></Page>;
  const c = o.company;
  const quote = o.status === 'draft';
  const title = quote ? 'QUOTATION' : 'SALES ORDER';
  const t = o.totals;
  const interState = Number(t.igst_total) > 0;
  const waPhone = String(o.party?.phone ?? '').replace(/\D/g, '');
  const waText = `${c.name}\n${quote ? 'Quotation' : 'Order'} ${o.order_no} dated ${date(o.order_date)}\nTotal: Rs ${inr(t.grand_total)}`;

  return (
    <Page title={`${quote ? 'Quotation' : 'Sales order'} ${o.order_no}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {waPhone && <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`}>Share on WhatsApp</a>}
        <Link className="button" href={`/sales/orders/${id}`}>Back to the {quote ? 'quote' : 'order'}</Link>
      </>
    }>
      <div className="doc">
        <h1>{title}</h1>
        <div className="head">
          <div>
            <strong>{c.name}</strong><br />
            {addr(c.address)}<br />
            {c.gstin && <>GSTIN: {c.gstin}<br /></>}
            State: {STATE_CODES[c.state_code]} ({c.state_code})
            {c.phone && <><br />Phone: {c.phone}</>}
            {c.email && <><br />{c.email}</>}
          </div>
          <div>
            <strong>{quote ? 'Quotation no' : 'Order no'}:</strong> {o.order_no}<br />
            <strong>Date:</strong> {date(o.order_date)}<br />
            <strong>Place of supply:</strong> {STATE_CODES[o.place_of_supply]} ({o.place_of_supply})
          </div>
        </div>
        <div className="head">
          <div>
            <strong>{quote ? 'Quotation for' : 'Order from'}</strong><br />
            {o.party?.name ?? 'Cash sale'}<br />
            {addr(o.party?.billing_address)}{addr(o.party?.billing_address) && <br />}
            {o.party?.phone && <>Phone: {o.party.phone}<br /></>}
            {o.party?.gstin && <>GSTIN: {o.party.gstin}</>}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Item</th><th>HSN/SAC</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Discount</th>
              <th className="right">Taxable</th><th className="right">GST</th><th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l: any, i: number) => (
              <tr key={l.id}>
                <td>{i + 1}</td><td>{l.item_name}</td><td>{l.hsn_sac}</td><td className="right">{num(l.qty)} {l.unit}</td>
                <td className="right">{inr(l.rate)}</td><td className="right">{Number(l.discount) ? inr(l.discount) : ''}</td>
                <td className="right">{inr(l.taxable_value)}</td><td className="right">{num(l.gst_rate)}%</td><td className="right">{inr(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={8} className="right">Taxable value</td><td className="right">{inr(t.taxable_total)}</td></tr>
            {interState
              ? <tr><td colSpan={8} className="right">IGST</td><td className="right">{inr(t.igst_total)}</td></tr>
              : <><tr><td colSpan={8} className="right">CGST</td><td className="right">{inr(t.cgst_total)}</td></tr>
                <tr><td colSpan={8} className="right">SGST</td><td className="right">{inr(t.sgst_total)}</td></tr></>}
            {Number(t.cess_total) > 0 && <tr><td colSpan={8} className="right">Cess</td><td className="right">{inr(t.cess_total)}</td></tr>}
            {Number(t.round_off) !== 0 && <tr><td colSpan={8} className="right">Round off</td><td className="right">{inr(t.round_off)}</td></tr>}
            <tr><td colSpan={8} className="right"><strong>Total</strong></td><td className="right"><strong>₹{inr(t.grand_total)}</strong></td></tr>
          </tfoot>
        </table>
        <p className="words">{amountInWords(t.grand_total)}</p>
        {o.notes && <p className="small">Notes: {o.notes}</p>}
        {quote && <p className="small">This is a quotation, not a tax invoice. Prices are as on the date above and are subject to stock being available when the order is confirmed.</p>}
        {c.bank?.account_no && (
          <p className="small">Bank: {c.bank.bank_name} · A/c {c.bank.account_no} · IFSC {c.bank.ifsc}{c.bank.upi_id ? ` · UPI ${c.bank.upi_id}` : ''}</p>
        )}
        <div className="sign">For {c.name}<br /><br /><br />Authorised signatory</div>
      </div>
    </Page>
  );
}
