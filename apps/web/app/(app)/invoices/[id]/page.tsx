'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { InvoiceDocument } from '@/components/invoice';
import { ActionButton, Card, ErrorBox, Loading, Page, SmartButton, StatusBar, Table, Toggle, date, inr, num } from '@/components/ui';
import { post, useGet, useSaving } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Send the bill to the customer: a link that opens it, by WhatsApp to their number when we have one, or copied. */
function ShareBill({ id, phone, text }: { id: string; phone: string; text: string }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function share(how: 'whatsapp' | 'copy') {
    // The new tab is opened in the click itself (browsers block one opened later), then pointed at WhatsApp.
    const tab = how === 'whatsapp' ? window.open('', '_blank') : null;
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/sales/invoices/${id}/share`);
      const link = `${window.location.origin}${res.data.path}`;
      if (tab) tab.location.href = `https://wa.me/${phone}?text=${encodeURIComponent(`${text}
View it here: ${link}`)}`;
      else { await navigator.clipboard.writeText(link); setCopied(true); }
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {phone ? <button type="button" disabled={busy} onClick={() => share('whatsapp')}>Send on WhatsApp</button> : null}
      <button type="button" disabled={busy} onClick={() => share('copy')}>{copied ? 'Link copied' : 'Copy link to bill'}</button>
      {error ? <span className="error small">{error}</span> : null}
    </>
  );
}

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
  const waText = `${c.name}\n${isCn ? 'Credit note' : 'Invoice'} ${inv.invoice_no} dated ${date(inv.invoice_date)}\nAmount: Rs ${inr(inv.grand_total)}\nThank you!`;
  const waPhone = (inv.party_phone ?? '').replace(/\D/g, '');

  const paid = inv.status === 'issued' && inv.payment?.payment_status === 'paid';
  const outstanding = inv.payment ? Number(inv.payment.outstanding) : 0;
  const received = inv.payments.reduce((t: number, r: any) => t + Number(r.amount), 0);
  const rupees = (n: number) => `₹${inr(n).replace(/\.00$/, '')}`;

  return (
    <Page title={`${isCn ? 'Credit note' : 'Invoice'} ${inv.invoice_no}`}
      smart={
        <>
          {inv.party_id ? <SmartButton icon="me" value={inv.party_name} label="Customer" href={`/parties/${inv.party_id}`} /> : <SmartButton icon="me" value={inv.party_name ?? 'Cash sale'} label="Customer" />}
          {inv.order ? <SmartButton icon="sales" value={inv.order.order_no} label="Order" href={`/sales/orders/${inv.order.id}`} /> : null}
          {inv.job_card ? <SmartButton icon="service" value={inv.job_card.job_no} label="Job card" href={`/service/${inv.job_card.id}`} /> : null}
          {inv.against_invoice ? <SmartButton icon="accounts" value={inv.against_invoice.invoice_no} label="Against invoice" href={`/invoices/${inv.against_invoice.id}`} /> : null}
          {!isCn && inv.status === 'issued' ? (
            <SmartButton icon="rupee" value={outstanding > 0 ? rupees(outstanding) : 'Nil'} label={outstanding > 0 ? 'Still to pay' : 'Fully paid'} tone={outstanding > 0 ? 'amber' : 'green'} />
          ) : null}
          {inv.payments.length > 0 ? <SmartButton icon="accounts" value={inv.payments.length} label={`Payments · ${rupees(received)}`} href="#payments" /> : null}
          {inv.credit_notes.length > 0 ? <SmartButton icon="accounts" value={inv.credit_notes.length} label="Credit notes" href="#credit-notes" /> : null}
        </>
      }
      status={
        <StatusBar steps={isCn ? ['Draft', 'Issued'] : ['Draft', 'Issued', 'Paid']} current={inv.status === 'draft' ? 0 : paid ? 2 : 1}
          stopped={inv.status === 'cancelled' ? 'Cancelled' : null} />
      }
      actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {inv.status !== 'draft' && <ShareBill id={id} phone={waPhone} text={waText} />}
        <button type="button" onClick={() => setThermal(!thermal)}>{thermal ? 'A4 layout' : 'Thermal layout'}</button>
      </>
    }>

      <InvoiceDocument inv={inv} thermal={thermal} />

      <div className="no-print" style={{ marginTop: 16 }}>
        {inv.payments.length > 0 && (
          <Card title="Payments received" id="payments">
            <Table rows={inv.payments} columns={[
              { key: 'payment_no', title: 'Receipt' }, { key: 'paid_on', title: 'Date', render: (r) => date(r.paid_on) },
              { key: 'mode', title: 'Mode' }, { key: 'reference', title: 'Reference' },
              { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            ]} />
          </Card>
        )}
        {inv.credit_notes.length > 0 && (
          <Card title="Credit notes" id="credit-notes">
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
  const saving = useSaving();
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
        <div className="form-foot"><button type="button" className="primary" disabled={saving.busy} onClick={() => saving.run(save)}>{saving.busy ? 'Saving…' : 'Issue credit note'}</button><ErrorBox error={error} /></div>
      </div>
    </div>
  );
}

function CancelForm({ id, hasPayments, onDone }: { id: string; hasPayments: boolean; onDone: () => void }) {
  const saving = useSaving();
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
        <button type="button" className="danger" disabled={saving.busy} onClick={() => saving.run(async () => {
          setError(null);
          try {
            await post(`/sales/invoices/${id}/cancel`, { reason, restock, cancel_payments: cancelPayments });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        })}>{saving.busy ? 'Saving…' : 'Cancel invoice'}</button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
