'use client';

import { useParams } from 'next/navigation';
import { InvoiceDocument } from '@/components/invoice';
import { inr } from '@/components/ui';
import { useGet } from '@/lib/api';

/** The bill as the customer sees it when they open the link we sent. No sign-in. */
export default function SharedInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const { data, error } = useGet<{ data: any }>(`/public/invoices/${token}`);
  const inv = data?.data;
  if (error) {
    return (
      <div className="center">
        <div className="card"><h1 style={{ marginBottom: 8 }}>This link is not available</h1><p className="muted">Ask whoever sent it to you for a new one.</p></div>
      </div>
    );
  }
  if (!inv) return <div className="center muted">Loading…</div>;
  const owed = inv.payment && inv.status === 'issued' ? Number(inv.payment.outstanding) : 0;
  return (
    <div className="shared">
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span>
          {inv.status === 'cancelled' ? <span className="badge red">Cancelled</span>
            : inv.doc_type === 'credit_note' ? <span className="badge blue">Credit note</span>
              : owed > 0 ? <span className="badge amber">₹{inr(inv.payment.outstanding)} to pay</span>
                : <span className="badge green">Paid</span>}
        </span>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
      </div>
      <InvoiceDocument inv={inv} />
    </div>
  );
}
