'use client';

import { isTradeParty } from '@radcore/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { LineEditor, toApiLines, type ItemLite, type Line } from '@/components/lines';
import { Card, ErrorBox, Page } from '@/components/ui';
import { post, useGet } from '@/lib/api';

function NewOrder() {
  const router = useRouter();
  const params = useSearchParams();
  const parties = useGet<{ data: any[] }>('/parties?limit=2000');
  const items = useGet<{ data: ItemLite[] }>('/items?limit=2000');
  // With more than one company (legal entity), the quote says which one is selling.
  const entities = useGet<{ data: { id: string; legal_name: string; is_default: boolean; active: boolean }[] }>('/masters/entities');
  const companies = (entities.data?.data ?? []).filter((e) => e.active);
  const [entityId, setEntityId] = useState('');
  const [partyId, setPartyId] = useState(params.get('party_id') ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const buyers = (parties.data?.data ?? []).filter((p) => p.party_type !== 'supplier');
  const party = buyers.find((p) => p.id === partyId);

  async function save() {
    setError(null);
    try {
      const res = await post('/sales/orders', {
        party_id: partyId, channel: isTradeParty(party?.party_type) ? 'dealer' : 'store', notes, lines: toApiLines(lines), entity_id: entityId || null,
        // A quote started from a lead stays linked to it (the lead's page lists it).
        lead_id: params.get('lead_id') || undefined,
      });
      router.push(`/sales/orders/${res.data.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Page title="New quote">
      <Card>
        <div className="form">
          <label><span>Customer / dealer *</span>
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">—</option>
              {buyers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.party_type})</option>)}
            </select>
          </label>
          {companies.length > 1 ? (
            <label><span>Selling company</span>
              <select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                {companies.map((c) => <option key={c.id} value={c.is_default ? '' : c.id}>{c.legal_name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="wide"><span>Notes</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
      </Card>
      <Card title="Items">
        <p className="muted small">Rates default to the party's price list (dealer prices exclude GST, retail prices include it). Type a rate only to override.</p>
        <LineEditor items={items.data?.data ?? []} lines={lines} onChange={setLines}
          priceKey={isTradeParty(party?.party_type) ? 'dealer_price' : 'retail_price'} filter={(i) => i.item_type !== 'raw_material'} />
      </Card>
      <ErrorBox error={error} />
      <p style={{ marginTop: 12 }}><button type="button" className="primary" disabled={!partyId || lines.length === 0} onClick={save}>Save quote</button></p>
    </Page>
  );
}

export default function NewOrderPage() {
  return <Suspense><NewOrder /></Suspense>;
}
