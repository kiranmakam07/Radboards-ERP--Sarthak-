'use client';

import { useState } from 'react';
import { qs, useGet } from '@/lib/api';

/**
 * Serial numbers, for items kept by serial (a vehicle, a battery pack). Going out, the serials are
 * picked from what is at that place (SerialPicker); coming in, they are typed or scanned
 * (SerialEntry). Either way the count must match the quantity, which the API checks again.
 */

/** Serials as typed: one per line, or separated by commas or spaces; upper case, none twice. */
export const parseSerials = (text: string): string[] =>
  [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

const countNote = (have: number, need: number) =>
  need === 0 && have === 0 ? <span className="muted small">pick one for each unit</span>
    : have === need ? <span className="muted small">{have} of {need} ✓</span> : <span className="error small">{have} of {need}</span>;

/** Pick the serials going out from those at a place: tap to pick, or scan one and press Enter. */
export function SerialPicker({ itemId, locationId, qty, value, onChange }: {
  itemId: string; locationId: string | null; qty: number; value: string[]; onChange: (serials: string[]) => void;
}) {
  const [typed, setTyped] = useState('');
  const { data } = useGet<{ data: { id: string; serial_no: string; status: string }[] }>(
    locationId ? `/units${qs({ item_id: itemId, location_id: locationId, in_stock: 'true', limit: 200 })}` : null);
  const here = data?.data ?? [];
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  return (
    <div className="serials">
      <div className="serials-head">
        <span className="small">Serials {countNote(value.length, qty)}</span>
        <input placeholder="Scan or type a serial, Enter" value={typed} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const add = parseSerials(typed).filter((s) => !value.includes(s));
            if (add.length) onChange([...value, ...add]);
            setTyped('');
          }} />
      </div>
      <div className="chips">
        {here.length === 0 && data ? <span className="muted small">None of this item is here.</span> : null}
        {here.map((u) => (
          <button key={u.id} type="button" className={`chip${value.includes(u.serial_no) ? ' on' : ''}`} aria-pressed={value.includes(u.serial_no)}
            onClick={() => toggle(u.serial_no)} title={u.status === 'demo' ? 'Demo unit' : undefined}>
            {u.serial_no}{u.status === 'demo' ? ' · demo' : ''}
          </button>
        ))}
        {value.filter((s) => !here.some((u) => u.serial_no === s)).map((s) => (
          <button key={s} type="button" className="chip on" onClick={() => toggle(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

/** Type or scan the serials coming in, one per unit. */
export function SerialEntry({ qty, value, onChange }: { qty: number; value: string[]; onChange: (serials: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <label className="serials">
      <span className="small">Serials, one per unit {countNote(value.length, qty)}</span>
      <textarea rows={Math.min(6, Math.max(2, qty))} value={text} placeholder="Scan each one, or paste a list"
        onChange={(e) => { setText(e.target.value); onChange(parseSerials(e.target.value)); }} />
    </label>
  );
}
