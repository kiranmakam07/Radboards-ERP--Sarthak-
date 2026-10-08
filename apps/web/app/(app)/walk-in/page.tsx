'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Card, ErrorBox, Notice, Page, date, inr } from '@/components/ui';
import { api, post, useGet } from '@/lib/api';

type Lookup = {
  leads: { id: string; lead_no: string; name: string; stage: string; source_name: string }[];
  parties: { id: string; name: string; party_type: string; balance: string }[];
  purchases: { id: string; invoice_no: string; invoice_date: string; grand_total: string; items: string }[];
};

/**
 * The store's one manual step (PRD 7.2): phone first (which triggers the repeat-customer
 * lookup), name, products, notes, outcome. Source, time and "attended by" are stamped by the server.
 */
export default function WalkInPage() {
  const router = useRouter();
  const products = useGet<{ data: { id: string; name: string; item_type: string }[] }>('/items?limit=1000');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [interested, setInterested] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const digits = phone.replace(/\D/g, '').slice(-10);
  useEffect(() => {
    if (digits.length !== 10) { setFound(null); return; }
    let cancelled = false;
    api(`/leads/lookup?phone=${digits}`)
      .then((r) => {
        if (cancelled) return;
        setFound(r.data);
        const known = r.data.parties[0]?.name ?? r.data.leads[0]?.name;
        if (known) setName((n: string) => n || known);
      })
      .catch(() => setFound(null));
    return () => { cancelled = true; };
  }, [digits]);

  async function save(outcome: 'enquiry' | 'buying_now') {
    setBusy(true); setError(null); setSaved(null);
    try {
      const res = await post('/leads/walk-in', { phone, name, interested_item_ids: interested, notes, outcome });
      if (outcome === 'buying_now') {
        router.push(`/quick-bill?party_id=${res.data.party.id}&items=${interested.join(',')}`);
        return;
      }
      setSaved(`Saved ${res.data.lead.lead_no}${res.data.duplicate ? ' (added to their existing enquiry)' : ''}.`);
      setPhone(''); setName(''); setInterested([]); setNotes(''); setFound(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sellable = (products.data?.data ?? []).filter((i) => i.item_type !== 'raw_material');
  return (
    <Page title="Walk-in">
      <div className="touch">
        <Notice>{saved}</Notice>
        <div className="form">
          <label><span>Phone *</span>
            <input type="tel" inputMode="numeric" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" />
          </label>
          {found && (found.parties.length > 0 || found.leads.length > 0) && (
            <Card title="Already with us">
              {found.parties.map((p) => (
                <div key={p.id}><Link href={`/parties/${p.id}`}>{p.name}</Link> <Badge value={p.party_type} />{Number(p.balance) > 0 ? <span className="muted"> owes ₹{inr(p.balance)}</span> : null}</div>
              ))}
              {found.leads.map((l) => (
                <div key={l.id}><Link href={`/leads/${l.id}`}>{l.lead_no}</Link> {l.name} <Badge value={l.stage} /> <span className="muted">{l.source_name}</span></div>
              ))}
              {found.purchases.length > 0 && <h3>Past purchases</h3>}
              {found.purchases.map((p) => (
                <div key={p.id} className="small"><Link href={`/invoices/${p.id}`}>{p.invoice_no}</Link> · {date(p.invoice_date)} · ₹{inr(p.grand_total)} · {p.items}</div>
              ))}
            </Card>
          )}
          <label><span>Name *</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label><span>Interested in</span>
            <select value="" onChange={(e) => e.target.value && setInterested([...new Set([...interested, e.target.value])])}>
              <option value="">+ Add product…</option>
              {sellable.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          {interested.length > 0 && (
            <div className="actions">
              {interested.map((id) => (
                <button key={id} type="button" onClick={() => setInterested(interested.filter((x) => x !== id))}>
                  {sellable.find((i) => i.id === id)?.name ?? id} ×
                </button>
              ))}
            </div>
          )}
          <label><span>Notes</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <div className="choice">
            <button type="button" disabled={busy || !phone || !name} onClick={() => save('enquiry')}>Just enquiring</button>
            <button type="button" className="on" disabled={busy || !phone || !name} onClick={() => save('buying_now')}>Buying now →</button>
          </div>
          <ErrorBox error={error} />
        </div>
      </div>
    </Page>
  );
}
