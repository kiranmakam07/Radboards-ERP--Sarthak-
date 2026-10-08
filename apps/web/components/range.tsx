'use client';

import { useState } from 'react';
import { qs } from '@/lib/api';

/** Date-range filter shared by the dashboards. Blank = month to date. */
export function useRange() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const picker = (
    <div className="filters no-print">
      <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      {(from || to) && <button type="button" onClick={() => { setFrom(''); setTo(''); }}>Month to date</button>}
    </div>
  );
  return { query: qs({ from, to }), picker };
}
