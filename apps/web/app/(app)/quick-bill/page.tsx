'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LineEditor, toApiLines, type ItemLite, type Line } from '@/components/lines';
import { Card, ErrorBox, Page, inr } from '@/components/ui';
import { api, post, useGet } from '@/lib/api';

const MODES = ['cash', 'upi', 'card'] as const;

function QuickBill() {
  const router = useRouter();
  const params = useSearchParams();
  const items = useGet<{ data: ItemLite[] }>('/items?limit=2000');
  const [partyId, setPartyId] = useState<string | null>(params.get('party_id'));
  const [party, setParty] = useState<{ name: string; phone: string | null } | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [lines, setLines] = useState<Line[]>(() =>
    (params.get('items') ?? '').split(',').filter(Boolean).map((id) => ({ item_id: id, qty: '1', rate: '', discount: '' })));
  const [pay, setPay] = useState<Record<string, string>>({ cash: '', upi: '', card: '' });
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!partyId) { setParty(null); return; }
    api(`/parties/${partyId}`).then((r) => setParty(r.data)).catch(() => setPartyId(null));
  }, [partyId]);

  // Find an existing customer as the phone is typed.
  const digits = phone.replace(/\D/g, '').slice(-10);
  useEffect(() => {
    if (partyId || digits.length !== 10) return;
    api(`/leads/lookup?phone=${digits}`).then((r) => {
      const p = r.data.parties[0];
      if (p) setPartyId(p.id);
      else if (r.data.leads[0]) setName((n: string) => n || r.data.leads[0].name);
    }).catch(() => undefined);
  }, [digits, partyId]);

  // Live price + GST from the server, so the screen always shows what will be billed.
  const key = JSON.stringify([partyId, lines]);
  useEffect(() => {
    const valid = lines.filter((l) => Number(l.qty) > 0);
    if (valid.length === 0) { setPreview(null); return; }
    const t = setTimeout(() => {
      post('/sales/price-preview', { party_id: partyId, lines: toApiLines(valid) })
        .then((r) => { setPreview(r.data); setError(null); })
        .catch((e: Error) => { setPreview(null); setError(e.message); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const total = Number(preview?.totals.grand_total ?? 0);
  const paid = MODES.reduce((s, m) => s + Number(pay[m] || 0), 0);
  const due = Math.round((total - paid) * 100) / 100;

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await post('/sales/quick-bill', {
        party_id: partyId,
        customer: !partyId && phone ? { phone, name } : null,
        lines: toApiLines(lines.filter((l) => Number(l.qty) > 0)),
        payments: MODES.filter((m) => Number(pay[m]) > 0).map((m) => ({ mode: m, amount: pay[m] })),
      });
      router.push(`/invoices/${res.data.invoice.id}?new=1`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Page title="Quick bill">
      <Card title="1. Customer">
        {party ? (
          <div className="actions">
            <strong>{party.name}</strong> <span className="muted">{party.phone}</span>
            <button type="button" onClick={() => { setPartyId(null); setPhone(''); setName(''); }}>Change</button>
          </div>
        ) : (
          <div className="form">
            <label><span>Phone</span><input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Find or add by mobile" /></label>
            <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
              Leave both blank for an anonymous cash sale (must be paid in full). A new customer is saved as a walk-in lead automatically.
            </p>
          </div>
        )}
      </Card>

      <Card title="2. Items">
        <LineEditor items={items.data?.data ?? []} lines={lines} onChange={setLines} priceKey="retail_price"
          stockKey="showroom_qty" stockLabel="in showroom" filter={(i) => i.item_type !== 'raw_material'} />
      </Card>

      <Card title="3. Payment">
        {preview ? (
          <>
            <div className="totals">
              <div><span>Taxable value</span><span>{inr(preview.totals.taxable_total)}</span></div>
              {Number(preview.totals.cgst_total) > 0 && <div><span>CGST</span><span>{inr(preview.totals.cgst_total)}</span></div>}
              {Number(preview.totals.sgst_total) > 0 && <div><span>SGST</span><span>{inr(preview.totals.sgst_total)}</span></div>}
              {Number(preview.totals.igst_total) > 0 && <div><span>IGST</span><span>{inr(preview.totals.igst_total)}</span></div>}
              {Number(preview.totals.round_off) !== 0 && <div><span>Round off</span><span>{inr(preview.totals.round_off)}</span></div>}
              <div className="grand"><span>Total</span><span>₹{inr(total)}</span></div>
            </div>
            <div className="form" style={{ marginTop: 12 }}>
              {MODES.map((m) => (
                <label key={m}><span>{m.toUpperCase()}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="number" min="0" step="any" value={pay[m]} onChange={(e) => setPay({ ...pay, [m]: e.target.value })} />
                    <button type="button" title="Put the full balance here"
                      onClick={() => setPay({ ...pay, [m]: String(Math.max(0, Math.round((total - (paid - Number(pay[m] || 0))) * 100) / 100)) })}>
                      Full
                    </button>
                  </div>
                </label>
              ))}
            </div>
            <p className={due > 0 ? 'error' : 'muted'} style={{ marginTop: 10 }}>
              {due > 0 ? `₹${inr(due)} will be left on credit${partyId || phone ? '' : ' — add a customer first'}.` : due < 0 ? 'Payments are more than the bill.' : 'Paid in full.'}
            </p>
          </>
        ) : <p className="muted">Add items to see the total.</p>}
        <ErrorBox error={error} />
        <div style={{ marginTop: 12 }}>
          <button type="button" className="primary big" disabled={busy || !preview || due < 0} onClick={save}>
            {busy ? 'Saving…' : 'Save & print invoice'}
          </button>
        </div>
      </Card>
    </Page>
  );
}

export default function QuickBillPage() {
  return <Suspense><QuickBill /></Suspense>;
}
