'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { istDate, PAYMENT_MODES } from '@radcore/shared';
import { ActionButton, Badge, Card, CsvLink, ErrorBox, Loading, Page, Table, Toggle, date, inr, label } from '@/components/ui';
import { api, post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

function Payments() {
  const params = useSearchParams();
  const can = useCan();
  const preset = params.get('party_id') ?? '';
  const [f, setF] = useState({ direction: '', party_id: preset });
  const path = `/payments${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Payments" actions={<CsvLink href={path} />}>
      {can('payments:write') && <Toggle label="+ Record payment" open={Boolean(preset)}><PaymentForm presetParty={preset} onDone={reload} /></Toggle>}
      <div className="filters">
        {[['', 'All'], ['in', 'Money in'], ['out', 'Money out']].map(([v, l]) => (
          <button key={v} type="button" className={f.direction === v ? 'primary' : undefined} onClick={() => setF({ ...f, direction: v! })}>{l}</button>
        ))}
        {f.party_id && <button type="button" onClick={() => setF({ ...f, party_id: '' })}>Showing one party × clear</button>}
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No payments yet." rowHref={(r) => `/payments/${r.id}`} columns={[
        { key: 'payment_no', title: 'Number' }, { key: 'paid_on', title: 'Date', render: (r) => date(r.paid_on) },
        { key: 'direction', title: '', render: (r) => (r.direction === 'in' ? 'Received' : 'Paid') },
        { key: 'party_name', title: 'Party', render: (r) => r.party_name ?? 'Cash sale' },
        { key: 'mode', title: 'Mode', render: (r) => label(r.mode) }, { key: 'account_name', title: 'Account' }, { key: 'reference', title: 'Reference' },
        { key: 'amount', title: 'Amount', align: 'right', render: (r) => inr(r.amount) },
        { key: 'unallocated', title: 'Advance (unallocated)', align: 'right', render: (r) => (Number(r.unallocated) > 0 ? inr(r.unallocated) : '') },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'x', title: '', render: (r) => (r.status === 'posted' && can('payments:write') ? (
          <ActionButton kind="danger" confirm={`Cancel ${r.payment_no}? Its entries will be reversed and the invoices become unpaid again.`}
            onClick={() => post(`/payments/${r.id}/cancel`, { reason: 'Cancelled by accounts' })} onDone={reload}>Cancel</ActionButton>
        ) : null) },
      ]} />
    </Page>
  );
}

/** Money in or out, allocated across the party's open invoices/bills; the rest stays as an advance. */
function PaymentForm({ presetParty, onDone }: { presetParty: string; onDone: () => void }) {
  const parties = useGet<{ data: any[] }>('/parties?limit=2000');
  const accounts = useGet<{ data: any[] }>('/accounting/money-accounts');
  const [partyId, setPartyId] = useState(presetParty);
  const [party, setParty] = useState<any>(null);
  const [v, setV] = useState({ amount: '', mode: 'bank_transfer', account_id: '', reference: '', paid_on: istDate(), direction: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAlloc({});
    if (!partyId) { setParty(null); return; }
    api(`/parties/${partyId}`).then((r) => setParty(r.data)).catch(() => setParty(null));
  }, [partyId]);

  const direction = v.direction || (party?.party_type === 'supplier' ? 'out' : 'in');
  const open: any[] = party ? (direction === 'in' ? party.open_invoices : party.open_bills) : [];
  const idKey = direction === 'in' ? 'invoice_id' : 'bill_id';
  const allocated = Object.values(alloc).reduce((s, a) => s + Number(a || 0), 0);

  // Oldest first, until the amount runs out.
  function autoAllocate() {
    let left = Number(v.amount || 0);
    const next: Record<string, string> = {};
    for (const doc of open) {
      if (left <= 0) break;
      const take = Math.min(left, Number(doc.outstanding));
      next[doc[idKey]] = take.toFixed(2);
      left = Math.round((left - take) * 100) / 100;
    }
    setAlloc(next);
  }

  async function save() {
    setError(null);
    try {
      await post('/payments', {
        direction, party_id: partyId, mode: v.mode, account_id: v.account_id, amount: v.amount, reference: v.reference, paid_on: v.paid_on,
        allocations: Object.entries(alloc).filter(([, a]) => Number(a) > 0)
          .map(([docId, amount]) => (direction === 'in' ? { invoice_id: docId, amount } : { purchase_bill_id: docId, amount })),
      });
      setV({ ...v, amount: '', reference: '' }); setAlloc({});
      const fresh = await api(`/parties/${partyId}`);
      setParty(fresh.data);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="form">
        <label><span>Party *</span>
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">—</option>{(parties.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.party_type})</option>)}
          </select>
        </label>
        <label><span>Direction</span>
          <select value={direction} onChange={(e) => { setV({ ...v, direction: e.target.value }); setAlloc({}); }}>
            <option value="in">Money in (received)</option><option value="out">Money out (paid)</option>
          </select>
        </label>
        <label><span>Amount ₹ *</span><input type="number" min="0" step="any" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></label>
        <label><span>Mode *</span>
          <select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
        </label>
        <label><span>Cash / bank account</span>
          <select value={v.account_id} onChange={(e) => setV({ ...v, account_id: e.target.value })}>
            <option value="">Default for the mode</option>{(accounts.data?.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label><span>Reference (UTR / cheque no)</span><input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></label>
        <label><span>Date *</span><input type="date" value={v.paid_on} onChange={(e) => setV({ ...v, paid_on: e.target.value })} /></label>
      </div>
      {party && (
        <Card title={direction === 'in' ? 'Allocate to invoices' : 'Allocate to bills'} actions={<button type="button" onClick={autoAllocate}>Auto-allocate oldest first</button>}>
          <Table rows={open} empty="Nothing outstanding — the whole amount will be kept as an advance." columns={[
            { key: 'no', title: 'Document', render: (r) => r.invoice_no ?? `${r.bill_no} (${r.supplier_invoice_no})` },
            { key: 'due_date', title: 'Due', render: (r) => date(r.due_date) },
            { key: 'outstanding', title: 'Outstanding', align: 'right', render: (r) => inr(r.outstanding) },
            { key: 'alloc', title: 'Allocate', align: 'right', render: (r) => (
              <input type="number" min="0" step="any" style={{ width: 120 }} value={alloc[r[idKey]] ?? ''} onChange={(e) => setAlloc({ ...alloc, [r[idKey]]: e.target.value })} />
            ) },
          ]} />
          <p className="muted small">Allocated ₹{inr(allocated)} of ₹{inr(v.amount || 0)}. Anything left over is kept as an advance.</p>
        </Card>
      )}
      <div className="form-foot"><button type="button" className="primary" disabled={!partyId || !v.amount} onClick={save}>Save payment</button><ErrorBox error={error} /></div>
    </div>
  );
}

export default function PaymentsPage() {
  return <Suspense><Payments /></Suspense>;
}
