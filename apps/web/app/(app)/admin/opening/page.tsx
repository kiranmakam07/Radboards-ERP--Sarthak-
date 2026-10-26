'use client';

import { useState } from 'react';
import { addDays, istDate } from '@radcore/shared';
import { Card, ErrorBox, Page, Table, inr } from '@/components/ui';
import { post, useGet } from '@/lib/api';

/**
 * Moving from Vyapar (modules/opening.ts): Vyapar's closing balances come in as RadCore's opening balances, and the
 * business carries on from there. Three files bring them in, each checked first and then brought in all or nothing;
 * a fourth step compares Vyapar's figures with RadCore's while the two run side by side.
 */
type Kind = 'parties' | 'items' | 'accounts';
type Checked = { rows: (Record<string, any> & { row: number; problems: string[] })[]; problems: number; imported: Record<string, any> | null };

const STEPS: { kind: Kind; title: string; what: string; columns: { key: string; title: string; render?: (r: any) => any }[] }[] = [
  {
    kind: 'parties', title: '1. Customers, dealers and suppliers',
    what: 'Vyapar: Parties, then the Excel button, saved as CSV. Each party comes in with the balance it closed at: what it owes us, or what we owe it. Payments against those old balances are taken on account.',
    columns: [
      { key: 'name', title: 'Name' }, { key: 'party_type', title: 'Type' }, { key: 'phone', title: 'Phone' }, { key: 'gstin', title: 'GSTIN' },
      { key: 'balance', title: 'Balance (+ owes us)', render: (r) => inr(r.balance) },
    ],
  },
  {
    kind: 'items', title: '2. Products and their stock',
    what: 'Vyapar: Items, then the Excel button (or the stock summary), saved as CSV. Each product comes in with its stock and what that stock is worth. A vehicle needs its serial numbers, separated by ;.',
    columns: [
      { key: 'sku', title: 'Code' }, { key: 'name', title: 'Name' }, { key: 'item_type', title: 'Kind' }, { key: 'hsn', title: 'HSN' },
      { key: 'gst_rate', title: 'GST %' }, { key: 'qty', title: 'Stock', render: (r) => Number(r.qty) || '' },
      { key: 'unit_cost', title: 'Cost each', render: (r) => (Number(r.qty) ? inr(r.unit_cost) : '') },
    ],
  },
  {
    kind: 'accounts', title: '3. Cash, bank and the other balances',
    what: 'From Vyapar\'s balance sheet on the cut-over date: cash, each bank account, loans, capital, GST credit carried forward. Customers, suppliers and stock are not given here: they came in with steps 1 and 2. Each account must be in the chart of accounts first.',
    columns: [
      { key: 'account', title: 'Account', render: (r) => `${r.code} ${r.account}` },
      { key: 'debit', title: 'Debit', render: (r) => (Number(r.debit) ? inr(r.debit) : '') },
      { key: 'credit', title: 'Credit', render: (r) => (Number(r.credit) ? inr(r.credit) : '') },
    ],
  },
];

export default function OpeningPage() {
  const [asOf, setAsOf] = useState(addDays(istDate(), -1));
  return (
    <Page title="Moving from Vyapar">
      <Card title="How it works">
        <p className="muted">
          Vyapar&apos;s closing balances on the cut-over date become RadCore&apos;s opening balances, and work carries on in RadCore from
          there. Old bills are not brought in one by one. Each file is checked first: every row is listed with anything wrong with it, and
          nothing is saved. Only a file with no problems can be brought in, and then all of it at once. Everything is posted against Opening
          Balance Equity, which in the end holds what the business is worth on Vyapar&apos;s figures.
        </p>
        <label>Balances as at (the last day in Vyapar) <input type="date" value={asOf} max={istDate()} onChange={(e) => setAsOf(e.target.value)} /></label>
      </Card>
      {STEPS.map((s) => <Step key={s.kind} step={s} asOf={asOf} />)}
      <Compare />
    </Page>
  );
}

/** A CSV file chosen on this computer, as text. */
function FilePick({ onText }: { onText: (name: string, text: string) => void }) {
  return (
    <input type="file" accept=".csv,text/csv"
      onChange={async (e) => {
        const f = e.target.files?.[0];
        if (f) onText(f.name, await f.text());
      }} />
  );
}

function Step({ step, asOf }: { step: (typeof STEPS)[number]; asOf: string }) {
  const places = useGet<{ data: { id: string; name: string; type: string; active: boolean }[] }>(step.kind === 'items' ? '/masters/locations' : null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [place, setPlace] = useState('');
  const [checked, setChecked] = useState<Checked | null>(null);
  const [done, setDone] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ data: Checked }>(`/opening/${step.kind}`, { csv: file.text, as_of: asOf, dry_run: dryRun, ...(place ? { location_id: place } : {}) });
      setChecked(res.data);
      if (!dryRun) setDone(res.data.imported);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={step.title} actions={<a className="button" href={`/api/opening/template/${step.kind}`}>Template (CSV)</a>}>
      <p className="muted small">{step.what}</p>
      {done ? (
        <p><strong>Brought in.</strong> {Object.entries(done).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' && /^-?\d+\.\d\d$/.test(v) ? `₹${inr(v)}` : v}`).join(' · ')}</p>
      ) : (
        <div className="form inline">
          <label><span>File</span><FilePick onText={(name, text) => { setFile({ name, text }); setChecked(null); }} /></label>
          {step.kind === 'items' ? (
            <label><span>Stock is at</span>
              <select value={place} onChange={(e) => setPlace(e.target.value)}>
                <option value="">Stores</option>
                {(places.data?.data ?? []).filter((p) => p.active && ['stores', 'showroom'].includes(p.type)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ) : null}
          <button type="button" disabled={!file || busy} onClick={() => send(true)}>{busy ? 'Working…' : 'Check'}</button>
          <button type="button" className="primary" disabled={!file || busy || !checked || checked.problems > 0}
            onClick={() => { if (window.confirm(`Bring in all ${checked?.rows.length} rows of ${file?.name}? This posts their balances.`)) void send(false); }}>Bring in</button>
        </div>
      )}
      <ErrorBox error={error} />
      {checked && !done ? (
        <>
          <p className={checked.problems ? 'error' : 'muted'}>
            {checked.rows.length} row{checked.rows.length === 1 ? '' : 's'} read. {checked.problems ? `${checked.problems} problem(s) to put right in the file first.` : 'No problems: it can be brought in.'}
          </p>
          <Table rows={[...checked.rows].sort((a, b) => b.problems.length - a.problems.length)} columns={[
            { key: 'row', title: 'Row' }, ...step.columns,
            { key: 'problems', title: 'Problems', render: (r) => (r.problems.length ? <span className="error small" style={{ whiteSpace: 'normal' }}>{r.problems.join('; ')}</span> : '') },
          ]} />
        </>
      ) : null}
    </Card>
  );
}

/** Vyapar's figures against RadCore's on a date, while the two run side by side. */
function Compare() {
  const [kind, setKind] = useState<Kind>('parties');
  const [on, setOn] = useState(istDate());
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [out, setOut] = useState<{ rows: any[]; totals: { vyapar: string; radcore: string; differences: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="4. Compare with Vyapar">
      <p className="muted small">
        While both run, export the same list from Vyapar (party balances, stock summary, or the balance sheet&apos;s accounts) on a date and
        compare it here: each line with both figures and the difference. Lines that agree are at the bottom.
      </p>
      <div className="form inline">
        <label><span>Compare</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setOut(null); }}>
            <option value="parties">Party balances</option><option value="items">Stock value</option><option value="accounts">Account balances</option>
          </select>
        </label>
        <label><span>On</span><input type="date" value={on} max={istDate()} onChange={(e) => setOn(e.target.value)} /></label>
        <label><span>Vyapar&apos;s file</span><FilePick onText={(name, text) => { setFile({ name, text }); setOut(null); }} /></label>
        <button type="button" className="primary" disabled={!file}
          onClick={async () => {
            setError(null);
            try {
              setOut((await post<{ data: any }>(`/opening/compare/${kind}`, { csv: file!.text, as_of: on })).data);
            } catch (e) {
              setError((e as Error).message);
            }
          }}>Compare</button>
      </div>
      <ErrorBox error={error} />
      {out ? (
        <>
          <p className={out.totals.differences ? 'error' : 'muted'}>
            {out.totals.differences ? `${out.totals.differences} line(s) differ.` : 'Everything agrees.'} Vyapar ₹{inr(out.totals.vyapar)}, RadCore ₹{inr(out.totals.radcore)}.
          </p>
          <Table rows={[...out.rows].sort((a, b) => Number(Number(b.difference) !== 0 || !b.found) - Number(Number(a.difference) !== 0 || !a.found))} columns={[
            { key: 'name', title: kind === 'items' ? 'Item' : kind === 'parties' ? 'Party' : 'Account', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.name}{!r.found ? <span className="error small"> · not in RadCore</span> : r.row === null ? <span className="muted small"> · not in Vyapar&apos;s file</span> : null}</span> },
            { key: 'vyapar', title: 'Vyapar', align: 'right', render: (r) => (r.vyapar === null ? '' : inr(r.vyapar)) },
            { key: 'radcore', title: 'RadCore', align: 'right', render: (r) => inr(r.radcore) },
            { key: 'difference', title: 'Difference', align: 'right', render: (r) => (Number(r.difference) ? <strong className="error">{inr(r.difference)}</strong> : '') },
          ]} />
        </>
      ) : null}
    </Card>
  );
}
