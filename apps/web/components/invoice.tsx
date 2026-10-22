'use client';

import { STATE_CODES } from '@radcore/shared';
import { addr, date, inr, num } from '@/components/ui';

/**
 * A tax invoice or credit note as a document, laid out for A4 or a thermal printer (PRD 7.9, 7.11).
 * The same component draws it for our own people and for the customer who opens the link we sent.
 */
export function InvoiceDocument({ inv, thermal = false }: { inv: any; thermal?: boolean }) {
  const isCn = inv.doc_type === 'credit_note';
  const c = inv.company;
  const title = isCn ? 'CREDIT NOTE' : inv.is_b2b ? 'TAX INVOICE' : 'TAX INVOICE (B2C)';
  return (
    <div className={thermal ? 'doc thermal' : 'doc'}>
      <h1>{title}</h1>
      {inv.status === 'cancelled' && <p style={{ textAlign: 'center' }}><span className="cancelled-stamp">CANCELLED</span></p>}
      <div className="head">
        <div>
          <strong>{c.name}</strong><br />
          {addr(c.address)}<br />
          {c.gstin && <>GSTIN: {c.gstin}<br /></>}
          State: {STATE_CODES[c.state_code]} ({c.state_code})
          {c.phone && <><br />Phone: {c.phone}</>}
        </div>
        <div>
          <strong>{isCn ? 'Credit note' : 'Invoice'} no:</strong> {inv.invoice_no}<br />
          <strong>Date:</strong> {date(inv.invoice_date)}<br />
          {inv.against_invoice && <><strong>Against invoice:</strong> {inv.against_invoice.invoice_no} ({date(inv.against_invoice.invoice_date)})<br /></>}
          <strong>Place of supply:</strong> {inv.place_of_supply_name} ({inv.place_of_supply})
          {inv.reason && <><br /><strong>Reason:</strong> {inv.reason}</>}
        </div>
      </div>
      <div className="head">
        <div>
          <strong>Bill to</strong><br />
          {inv.party_name}<br />
          {addr(inv.billing_address)}{addr(inv.billing_address) && <br />}
          {inv.party_phone && <>Phone: {inv.party_phone}<br /></>}
          {inv.party_gstin && <>GSTIN: {inv.party_gstin}</>}
        </div>
        {addr(inv.shipping_address) && !thermal && <div><strong>Ship to</strong><br />{addr(inv.shipping_address)}</div>}
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th><th>Item</th><th className="hide-thermal">HSN/SAC</th><th className="right">Qty</th><th className="right">Rate</th>
            <th className="right hide-thermal">Disc.</th><th className="right hide-thermal">Taxable</th><th className="right hide-thermal">GST %</th>
            <th className="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l: any, i: number) => (
            <tr key={l.id}>
              <td>{i + 1}</td><td>{l.description}{l.serials?.length ? <><br /><span className="small">Serial: {l.serials.join(', ')}</span></> : null}</td><td className="hide-thermal">{l.hsn_sac}</td>
              <td className="right">{num(l.qty)} {l.unit}</td><td className="right">{inr(l.rate)}</td>
              <td className="right hide-thermal">{Number(l.discount) ? inr(l.discount) : ''}</td>
              <td className="right hide-thermal">{inr(l.taxable_value)}</td><td className="right hide-thermal">{num(l.gst_rate)}</td>
              <td className="right">{inr(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inv.tax_inclusive && <p className="small muted">Rates are inclusive of GST.</p>}

      <div className="totals" style={{ marginTop: 10 }}>
        <div><span>Taxable value</span><span>{inr(inv.taxable_total)}</span></div>
        {inv.is_inter_state
          ? <div><span>IGST</span><span>{inr(inv.igst_total)}</span></div>
          : <><div><span>CGST</span><span>{inr(inv.cgst_total)}</span></div><div><span>SGST</span><span>{inr(inv.sgst_total)}</span></div></>}
        {Number(inv.cess_total) > 0 && <div><span>Cess</span><span>{inr(inv.cess_total)}</span></div>}
        {Number(inv.round_off) !== 0 && <div><span>Round off</span><span>{inr(inv.round_off)}</span></div>}
        <div className="grand"><span>Total</span><span>₹{inr(inv.grand_total)}</span></div>
      </div>
      <p className="words">{inv.amount_in_words}</p>

      {!thermal && (
        <>
          <h3>HSN summary</h3>
          <table>
            <thead><tr><th>HSN/SAC</th><th className="right">GST %</th><th className="right">Taxable</th><th className="right">CGST</th><th className="right">SGST</th><th className="right">IGST</th>{Number(inv.cess_total) > 0 && <th className="right">Cess</th>}</tr></thead>
            <tbody>
              {inv.hsn_summary.map((h: any) => (
                <tr key={`${h.hsn_sac}-${h.gst_rate}`}>
                  <td>{h.hsn_sac}</td><td className="right">{num(h.gst_rate)}</td><td className="right">{inr(h.taxable_value)}</td>
                  <td className="right">{inr(h.cgst)}</td><td className="right">{inr(h.sgst)}</td><td className="right">{inr(h.igst)}</td>
                  {Number(inv.cess_total) > 0 && <td className="right">{inr(h.cess)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {c.bank?.account_no && (
            <p className="small" style={{ marginTop: 10 }}>
              <strong>Bank:</strong> {c.bank.bank_name} · A/c {c.bank.account_no} · IFSC {c.bank.ifsc}{c.bank.upi_id ? ` · UPI ${c.bank.upi_id}` : ''}
            </p>
          )}
          {c.invoice_terms && <p className="small muted">{c.invoice_terms}</p>}
          <div className="sign">For {c.name}<br /><br /><br />Authorised signatory</div>
        </>
      )}
    </div>
  );
}
