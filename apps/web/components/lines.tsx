'use client';

import { Fragment, useState } from 'react';
import { SerialPicker } from '@/components/serials';
import { api } from '@/lib/api';

export type Line = { item_id: string; qty: string; rate: string; discount: string; serials?: string[] };
export type ItemLite = {
  id: string; sku: string; name: string; unit: string; gst_rate: string; retail_price: string; dealer_price: string;
  purchase_cost?: string; on_hand?: string; showroom_qty?: string; stores_qty?: string; item_type: string; is_stock_item: boolean;
  is_serialised?: boolean;
};

/** Lines for the API: blank rate/discount means "use the price list" / "no discount"; serials only where picked. */
export const toApiLines = (lines: Line[], withDiscount = true) =>
  lines.map((l) => ({
    item_id: l.item_id, qty: l.qty, rate: l.rate === '' ? null : l.rate,
    ...(withDiscount ? { discount: l.discount === '' ? null : l.discount } : {}),
    ...(l.serials?.length ? { serials: l.serials } : {}),
  }));

/**
 * Item lines for a bill, quote or PO. Items are added by picking from the list or by
 * scanning/typing a barcode or SKU. The rate box shows the default as a placeholder and
 * only sends a value when someone overrides it.
 */
export function LineEditor({
  items, lines, onChange, priceKey, showDiscount = true, showStock = true, filter, stockKey = 'on_hand', stockLabel = 'in stock', serialsFrom,
}: {
  items: ItemLite[];
  lines: Line[];
  onChange: (lines: Line[]) => void;
  priceKey: 'retail_price' | 'dealer_price' | 'purchase_cost';
  showDiscount?: boolean;
  showStock?: boolean;
  filter?: (item: ItemLite) => boolean;
  /** Which stock figure to show beside each item: the location this document draws from. */
  stockKey?: 'on_hand' | 'showroom_qty' | 'stores_qty';
  stockLabel?: string;
  /** Goods leave from here now (the quick bill): items kept by serial get a row to pick their serials. */
  serialsFrom?: string | null;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const choices = filter ? items.filter(filter) : items;

  function add(itemId: string) {
    if (!itemId) return;
    const existing = lines.findIndex((l) => l.item_id === itemId);
    if (existing >= 0) {
      onChange(lines.map((l, i) => (i === existing ? { ...l, qty: String(Number(l.qty || 0) + 1) } : l)));
    } else onChange([...lines, { item_id: itemId, qty: '1', rate: '', discount: '' }]);
  }
  const update = (i: number, patch: Partial<Line>) => onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function scan() {
    const c = code.trim();
    if (!c) return;
    setError(null);
    try {
      const res = await api(`/items/lookup?code=${encodeURIComponent(c)}`);
      add(res.data.id);
      setCode('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="filters">
        <select value="" onChange={(e) => add(e.target.value)} className="grow">
          <option value="">+ Add item…</option>
          {choices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.sku} — {i.name}{showStock && i.is_stock_item ? ` (${Number(i[stockKey] ?? 0)} ${stockLabel})` : ''}
            </option>
          ))}
        </select>
        <input placeholder="Scan barcode / type SKU, press Enter" value={code} className="grow"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void scan(); } }} />
        {error ? <span className="error small">{error}</span> : null}
      </div>
      {lines.length > 0 && (
        <div className="table-wrap stack">
          <table>
            <thead>
              <tr>
                <th>Item</th><th className="right">Qty</th><th className="right">Rate</th>
                {showDiscount && <th className="right">Discount ₹</th>}<th className="right">GST %</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const item = byId.get(l.item_id);
                const picks = serialsFrom !== undefined && item?.is_serialised;
                return (
                  <Fragment key={l.item_id}>
                  <tr>
                    <td data-label="Item">{item ? `${item.sku} — ${item.name}` : l.item_id}</td>
                    <td className="right" data-label="Qty"><input type="number" inputMode="decimal" min="0" step="any" value={l.qty} style={{ width: 80 }} onChange={(e) => update(i, { qty: e.target.value })} /></td>
                    <td className="right" data-label="Rate"><input type="number" inputMode="decimal" min="0" step="any" value={l.rate} placeholder={item ? String(Number(item[priceKey])) : ''} style={{ width: 110 }} onChange={(e) => update(i, { rate: e.target.value })} /></td>
                    {showDiscount && <td className="right" data-label="Discount ₹"><input type="number" inputMode="decimal" min="0" step="any" value={l.discount} placeholder="0" style={{ width: 90 }} onChange={(e) => update(i, { discount: e.target.value })} /></td>}
                    <td className="right" data-label="GST %">{item ? Number(item.gst_rate) : ''}</td>
                    <td data-label=""><button type="button" onClick={() => onChange(lines.filter((_, idx) => idx !== i))}>Remove</button></td>
                  </tr>
                  {picks ? (
                    <tr className="serial-row">
                      <td colSpan={showDiscount ? 6 : 5}>
                        <SerialPicker itemId={l.item_id} locationId={serialsFrom ?? null} qty={Number(l.qty) || 0} value={l.serials ?? []}
                          onChange={(serials) => update(i, { serials, qty: serials.length > Number(l.qty || 0) ? String(serials.length) : l.qty })} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
