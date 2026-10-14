'use client';

import { useState } from 'react';
import { LineEditor, toApiLines, type ItemLite, type Line } from '@/components/lines';
import { ErrorBox, Toggle } from '@/components/ui';
import { put, useGet } from '@/lib/api';

/**
 * Give EditLines this as its `key`: it starts from a copy of the lines, so it must start again when
 * any of them changes, including when fresh figures replace remembered ones (lib/api.ts).
 */
export const linesKey = (lines: any[]) => lines.map((l) => `${l.id}:${l.qty}:${l.rate}:${l.discount ?? ''}`).join('|');

/**
 * Change the items on a quote or a purchase order that has not gone anywhere yet (still a draft).
 * Once a quote is confirmed, or a purchase order sent to the supplier, it is cancelled and made
 * again instead: the API refuses a change to anything but a draft.
 */
export function EditLines({ path, lines, priceKey, withDiscount = true, filter, onDone }: {
  /** Where the new lines are sent, e.g. /sales/orders/<id>/lines. */
  path: string;
  /** The lines as the document has them now. */
  lines: any[];
  priceKey: 'retail_price' | 'dealer_price' | 'purchase_cost';
  withDiscount?: boolean;
  filter?: (item: ItemLite) => boolean;
  onDone: () => void;
}) {
  const items = useGet<{ data: ItemLite[] }>('/items?limit=2000');
  const [draft, setDraft] = useState<Line[]>(() => lines.map((l) => ({
    item_id: l.item_id, qty: String(Number(l.qty)), rate: String(Number(l.rate)), discount: Number(l.discount ?? 0) ? String(Number(l.discount)) : '',
  })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await put(path, { lines: toApiLines(draft, withDiscount) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Toggle label="Change the items">
      <LineEditor items={items.data?.data ?? []} lines={draft} onChange={setDraft} priceKey={priceKey} showDiscount={withDiscount} filter={filter} />
      <ErrorBox error={error} />
      <p><button type="button" className="primary" disabled={busy || draft.length === 0} onClick={save}>Save the changes</button></p>
    </Toggle>
  );
}
