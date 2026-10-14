'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES, amountInWords } from '@radcore/shared';
import { ActionButton, Badge, Card, Loading, Page, Table, addr, date, inr, label } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Payment receipt (money in) or payment voucher (money out), laid out for printing (PRD 7.11). */
export default function PaymentReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/payments/${id}`);
  const settings = useGet<{ data: any }>('/settings');
  const p = data?.data;
  const c = settings.data?.data.company;
  if (!p || !c) return <Page title="Payment"><Loading loading={loading || settings.loading} error={error ?? settings.error} /></Page>;
  const received = p.direction === 'in';
  const allocated = p.allocations.reduce((s: number, a: any) => s + Number(a.amount), 0);
  const tds = Number(p.tds_amount);
  const settled = Math.round((Number(p.amount) + tds) * 100) / 100;
  const advance = Math.round((settled - allocated) * 100) / 100;

  return (
    <Page title={`${received ? 'Receipt' : 'Payment'} ${p.payment_no}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {p.party_id && <Link className="button" href={`/parties/${p.party_id}`}>{p.party_name}</Link>}
      </>
    }>
      <div className="no-print" style={{ marginBottom: 12 }}><Badge value={p.status} /></div>
      <div className="doc">
        <h1>{received ? 'PAYMENT RECEIPT' : 'PAYMENT VOUCHER'}</h1>
        {p.status === 'cancelled' && <p style={{ textAlign: 'center' }}><span className="cancelled-stamp">CANCELLED</span></p>}
        <div className="head">
          <div>
            <strong>{c.name}</strong><br />
            {addr(c.address)}<br />
            {c.gstin && <>GSTIN: {c.gstin}<br /></>}
            State: {STATE_CODES[c.state_code]} ({c.state_code})
          </div>
          <div>
            <strong>{received ? 'Receipt' : 'Voucher'} no:</strong> {p.payment_no}<br />
            <strong>Date:</strong> {date(p.paid_on)}<br />
            <strong>Mode:</strong> {label(p.mode)}{p.reference ? ` (ref ${p.reference})` : ''}<br />
            <strong>{received ? 'Deposited to' : 'Paid from'}:</strong> {p.account_name}
          </div>
        </div>
        <p>
          {received ? 'Received with thanks from' : 'Paid to'} <strong>{p.party_name ?? 'Cash sale'}</strong> the sum of{' '}
          <strong>₹{inr(p.amount)}</strong>.
        </p>
        <p className="words">{amountInWords(p.amount)}</p>
        {tds > 0 && (
          <p>
            Tax deducted at source{p.tds_rate_name ? ` (${p.tds_rate_name})` : ''}: <strong>₹{inr(tds)}</strong>
            {p.tds_base ? <> on ₹{inr(p.tds_base)}</> : null}. Settled on the account: <strong>₹{inr(settled)}</strong>.
          </p>
        )}
        {p.allocations.length > 0 ? (
          <table>
            <thead><tr><th>Against</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {p.allocations.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.invoice_no ? `Invoice ${a.invoice_no}` : `Bill ${a.bill_no}${a.supplier_invoice_no ? ` (supplier invoice ${a.supplier_invoice_no})` : ''}`}</td>
                  <td className="right">{inr(a.amount)}</td>
                </tr>
              ))}
              {advance > 0 && <tr><td>Advance, not yet set against a document</td><td className="right">{inr(advance)}</td></tr>}
            </tbody>
          </table>
        ) : (
          <p className="small">Held as an advance; not yet set against a document.</p>
        )}
        {p.notes && <p className="small">Notes: {p.notes}</p>}
        <div className="sign">For {c.name}<br /><br /><br />Authorised signatory</div>
      </div>
      {p.status === 'posted' && advance > 0 && p.party_id && can('payments:write') && <SetAdvance payment={p} left={advance} onDone={reload} />}
    </Page>
  );
}

/**
 * Part of this payment is an advance: money that came in (or went out) before the bill it is for.
 * When that bill exists, the advance is set against it here, so the bill shows as paid.
 */
function SetAdvance({ payment, left, onDone }: { payment: any; left: number; onDone: () => void }) {
  const party = useGet<{ data: any }>(`/parties/${payment.party_id}`);
  const p = party.data?.data;
  const received = payment.direction === 'in';
  const docs: { key: string; id: string; no: string; date: string; outstanding: number; href: string }[] = !p ? [] : received
    ? p.open_invoices.map((d: any) => ({ key: 'invoice_id', id: d.invoice_id, no: d.invoice_no, date: d.invoice_date, outstanding: Number(d.outstanding), href: `/invoices/${d.invoice_id}` }))
    : p.open_bills.map((d: any) => ({ key: 'purchase_bill_id', id: d.bill_id, no: d.supplier_invoice_no ? `${d.bill_no} (${d.supplier_invoice_no})` : d.bill_no,
        date: d.bill_date, outstanding: Number(d.outstanding), href: `/purchasing/bills/${d.bill_id}` }));
  return (
    <div className="no-print" style={{ marginTop: 16 }}>
      <Card title="Set the advance against a bill">
        <p className="muted small">₹{inr(left)} of this payment is not set against anything yet. Pick the {received ? 'invoice' : 'bill'} it was for.</p>
        <Loading loading={party.loading && !p} error={party.error} />
        {p && (
          <Table rows={docs} empty={`${payment.party_name} has no unpaid ${received ? 'invoices' : 'bills'}.`} rowHref={(d) => d.href} columns={[
            { key: 'no', title: received ? 'Invoice' : 'Bill' },
            { key: 'date', title: 'Date', render: (d) => date(d.date) },
            { key: 'outstanding', title: 'Still unpaid', align: 'right', render: (d) => inr(d.outstanding) },
            { key: 'x', title: '', render: (d) => {
              const amount = Math.round(Math.min(left, d.outstanding) * 100) / 100;
              return <ActionButton onClick={() => post(`/payments/${payment.id}/allocate`, { allocations: [{ [d.key]: d.id, amount }] })} onDone={onDone}>Set ₹{inr(amount)} against it</ActionButton>;
            } },
          ]} />
        )}
      </Card>
    </div>
  );
}
