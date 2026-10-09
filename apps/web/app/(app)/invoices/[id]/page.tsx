'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATE_CODES } from '@radcore/shared';
import { ActionButton, Badge, Card, ErrorBox, Loading, Page, Table, Toggle, date, inr, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const addr = (a: any) => (a ? [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ') : '');

/** Tax invoice / credit note, laid out for A4 or thermal printing (PRD 7.9, 7.11). */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const can = useCan();
  const { data, loading, error, reload: reloadInvoice } = useGet<{ data: any }>(`/sales/invoices/${id}`);
  const creditInfo = useGet<{ data: any }>(`/sales/invoices/${id}/credits`);
  const reload = () => { reloadInvoice(); creditInfo.reload(); };
  const credits = creditInfo.data?.data;
  const canApply = can('invoices:adjust') || can('payments:write');
  const [thermal, setThermal] = useState(false);
  const inv = data?.data;
  if (!inv) return <Page title="Invoice"><Loading loading={loading} error={error} /></Page>;

  const isCn = inv.doc_type === 'credit_note';
  const c = inv.company;
  const title = isCn ? 'CREDIT NOTE' : inv.is_b2b ? 'TAX INVOICE' : 'TAX INVOICE (B2C)';
  const waText = `${c.name}\n${isCn ? 'Credit note' : 'Invoice'} ${inv.invoice_no} dated ${date(inv.invoice_date)}\nAmount: Rs ${inr(inv.grand_total)}\nThank you!`;
  const waPhone = (inv.party_phone ?? '').replace(/\D/g, '');

  return (
    <Page title={`${isCn ? 'Credit note' : 'Invoice'} ${inv.invoice_no}`} actions={
      <>
        <button type="button" onClick={() => setThermal(!thermal)}>{thermal ? 'A4 layout' : 'Thermal layout'}</button>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {waPhone && <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone}?text=${encodeURIComponent(waText)}`}>Share on WhatsApp</a>}
      </>
    }>
      <div className="no-print" style={{ marginBottom: 12 }}>
        <Badge value={inv.status} /> {inv.payment && inv.status === 'issued' && <Badge value={inv.payment.payment_status} />}
        {inv.payment && Number(inv.payment.outstanding) > 0 && <span> Outstanding ₹{inr(inv.payment.outstanding)}</span>}
        {inv.order && <span> · Order <Link href={`/sales/orders/${inv.order.id}`}>{inv.order.order_no}</Link></span>}
        {inv.against_invoice && <span> · Against <Link href={`/invoices/${inv.against_invoice.id}`}>{inv.against_invoice.invoice_no}</Link></span>}
      </div>

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
                <td>{i + 1}</td><td>{l.description}</td><td className="hide-thermal">{l.hsn_sac}</td>
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
          {Number(inv.round_off) !== 0 && <div><span>Round off</span><span>{inr(inv.round_off)}</span></div>}
          <div className="grand"><span>Total</span><span>₹{inr(inv.grand_total)}</span></div>
        </div>
        <p className="words">{inv.amount_in_words}</p>

        {!thermal && (
          <>
            <h3>HSN summary</h3>
            <table>
              <thead><tr><th>HSN/SAC</th><th className="right">GST %</th><th className="right">Taxable</th><th className="right">CGST</th><th className="right">SGST</th><th className="right">IGST</th></tr></thead>
              <tbody>
                {inv.hsn_summary.map((h: any) => (
                  <tr key={`${h.hsn_sac}-${h.gst_rate}`}>
                    <td>{h.hsn_sac}</td><td className="right">{num(h.gst_rate)}</td><td className="right">{inr(h.taxable_value)}</td>
                    <td className="right">{inr(h.cgst)}</td><td className="right">{inr(h.sgst)}</td><td className="right">{inr(h.igst)}</td>
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

      <div className="no-print" style={{ marginTop: 16 }}>
        {inv.payments.length > 0 && (
          <Card title="Payments received">
            <Table rows={inv.payments} columns={[
              { key: 'payment_no', title: 'Receipt' }, { key: 'paid_on', title: 'Date', render: (r) => date(r.paid_on) },
              { key: 'mode', title: 'Mode' }, { key: 'reference', title: 'Reference' },
              { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            ]} />
          </Card>
        )}
        {inv.credit_notes.length > 0 && (
          <Card title="Credit notes">
            <Table rows={inv.credit_notes} rowHref={(r) => `/invoices/${r.id}`} columns={[
              { key: 'invoice_no', title: 'Number' }, { key: 'invoice_date', title: 'Date', render: (r) => date(r.invoice_date) },
              { key: 'reason', title: 'Reason' }, { key: 'grand_total', title: 'Amount', align: 'right', render: (r) => inr(r.grand_total) },
            ]} />
          </Card>
        )}
        {credits && credits.applied.length > 0 && (
          <Card title="Credit from other returns, set against this invoice">
            <Table rows={credits.applied} columns={[
              { key: 'credit_note_no', title: 'Credit note', render: (r) => <Link href={`/invoices/${r.credit_note_id}`}>{r.credit_note_no}</Link> },
              { key: 'applied_on', title: 'Date', render: (r) => date(r.applied_on) },
              { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
              { key: 'actions', title: '', render: (r) => (canApply
                ? <ActionButton onClick={() => post(`/sales/credit-applications/${r.id}/take-back`)} onDone={reload} confirm="Take this credit back off the invoice?">Take back</ActionButton> : null) },
            ]} />
          </Card>
        )}
        {credits && credits.available.length > 0 && (
          <Card title="This customer has credit from a return">
            <p className="muted small">Goods came back on an invoice that was already paid, so the customer is in credit. It can be set against what is still owed here (₹{inr(credits.outstanding)}).</p>
            <Table rows={credits.available} columns={[
              { key: 'credit_note_no', title: 'Credit note', render: (r) => <Link href={`/invoices/${r.credit_note_id}`}>{r.credit_note_no}</Link> },
              { key: 'against_invoice_no', title: 'Return on' },
              { key: 'credit_note_date', title: 'Date', render: (r) => date(r.credit_note_date) },
              { key: 'available', title: 'Unused credit', align: 'right', render: (r) => inr(r.available) },
              { key: 'actions', title: '', render: (r) => (canApply ? (
                <ActionButton kind="primary" onClick={() => post(`/sales/invoices/${inv.id}/apply-credit`, { credit_note_id: r.credit_note_id })} onDone={reload}>
                  Use ₹{inr(Math.min(Number(r.available), Number(credits.outstanding)))} here
                </ActionButton>
              ) : null) },
            ]} />
          </Card>
        )}
        {credits && credits.used_on.length > 0 && (
          <Card title="Where this credit note's credit was used">
            <Table rows={credits.used_on} columns={[
              { key: 'invoice_no', title: 'Invoice', render: (r) => <Link href={`/invoices/${r.invoice_id}`}>{r.invoice_no}</Link> },
              { key: 'applied_on', title: 'Date', render: (r) => date(r.applied_on) },
              { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            ]} />
          </Card>
        )}
        {can('invoices:adjust') && inv.status === 'issued' && !isCn && (
          <>
            <Toggle label="Return goods (credit note)"><CreditNoteForm invoice={inv} onDone={(cn) => router.push(`/invoices/${cn.id}`)} /></Toggle>
            <Toggle label="Cancel this invoice"><CancelForm id={inv.id} hasPayments={inv.payments.length > 0} onDone={reload} /></Toggle>
          </>
        )}
        {can('invoices:adjust') && inv.status === 'issued' && isCn && (
          <ActionButton kind="danger" confirm="Cancel this credit note?" onDone={reload}
            onClick={() => post(`/sales/invoices/${inv.id}/cancel`, { reason: 'Credit note raised in error' })}>
            Cancel credit note
          </ActionButton>
        )}
      </div>
    </Page>
  );
}

function CreditNoteForm({ invoice, onDone }: { invoice: any; onDone: (cn: any) => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      const lines = Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([invoice_line_id, q]) => ({ invoice_line_id, qty: q }));
      const res = await post(`/sales/invoices/${invoice.id}/credit-note`, { lines, reason, restock });
      onDone(res.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div>
      <Table rows={invoice.lines} columns={[
        { key: 'description', title: 'Item' },
        { key: 'qty', title: 'Sold', align: 'right', render: (r) => num(r.qty) },
        { key: 'ret', title: 'Return qty', align: 'right', render: (r) => (
          <input type="number" min="0" step="any" style={{ width: 90 }} value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />
        ) },
      ]} />
      <div className="form" style={{ marginTop: 10 }}>
        <label className="wide"><span>Reason *</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /><span>Put the goods back into stock (Showroom)</span></label>
        <div className="form-foot"><button type="button" className="primary" onClick={save}>Issue credit note</button><ErrorBox error={error} /></div>
      </div>
    </div>
  );
}

function CancelForm({ id, hasPayments, onDone }: { id: string; hasPayments: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [cancelPayments, setCancelPayments] = useState(hasPayments);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="form">
      <p className="muted wide" style={{ gridColumn: '1 / -1', margin: 0 }}>
        The invoice number stays used and the document is kept as Cancelled. Use this for a bill raised by mistake; for goods coming back, raise a credit note.
      </p>
      <label className="wide"><span>Reason *</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /><span>The goods never left: put them back in stock</span></label>
      {hasPayments && <label className="check"><input type="checkbox" checked={cancelPayments} onChange={(e) => setCancelPayments(e.target.checked)} /><span>Also cancel the receipts taken for it</span></label>}
      <div className="form-foot">
        <button type="button" className="danger" onClick={async () => {
          setError(null);
          try {
            await post(`/sales/invoices/${id}/cancel`, { reason, restock, cancel_payments: cancelPayments });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Cancel invoice</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
