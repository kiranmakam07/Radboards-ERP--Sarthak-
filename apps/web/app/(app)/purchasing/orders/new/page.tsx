'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LineEditor, toApiLines, type ItemLite, type Line } from '@/components/lines';
import { Card, CurrencyFields, ErrorBox, Page, currencyBody } from '@/components/ui';
import { post, useGet, useSaving } from '@/lib/api';

export default function NewPurchaseOrderPage() {
  const saving = useSaving();
  const router = useRouter();
  const suppliers = useGet<{ data: any[] }>('/parties?type=supplier&limit=2000');
  const items = useGet<{ data: ItemLite[] }>('/items?limit=2000');
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [money, setMoney] = useState({ currency: 'INR', fx_rate: '' });
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const res = await post('/purchasing/orders', { supplier_id: supplierId, expected_date: expected, notes, lines: toApiLines(lines, false), ...currencyBody(money) });
      router.push(`/purchasing/orders/${res.data.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Page title="New purchase order">
      <Card>
        <div className="form">
          <label><span>Supplier *</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">—</option>{(suppliers.data?.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label><span>Expected date</span><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
          <CurrencyFields value={money} onChange={setMoney} />
          <label className="wide"><span>Notes</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
      </Card>
      <Card title="Items">
        <p className="muted small">Rates default to the item's last purchase cost (before GST). Accepted goods are valued at this PO rate.</p>
        <LineEditor items={items.data?.data ?? []} lines={lines} onChange={setLines} priceKey="purchase_cost" showDiscount={false}
          filter={(i) => i.is_stock_item} />
      </Card>
      <ErrorBox error={error} />
      <p style={{ marginTop: 12 }}><button type="button" className="primary" disabled={saving.busy || !supplierId || lines.length === 0} onClick={() => saving.run(save)}>{saving.busy ? 'Saving…' : 'Save PO'}</button></p>
    </Page>
  );
}
