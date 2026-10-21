'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { formatDate, formatINR } from '@radcore/shared';
import { BarList, Donut, LineChart, count } from '@/components/charts';
import { Icon } from '@/components/icons';
import { SessionContext } from '@/lib/session';

/**
 * The building blocks every screen is made of: how money, quantities and dates are shown, the
 * page frame, tables, forms, buttons that act and report what went wrong, and small layout pieces.
 * A screen should be these plus its own data; anything two screens need belongs here or in a
 * component of its own beside this file.
 */

// ---- how values are shown ---------------------------------------------------
export const inr = (v: unknown) => (v === null || v === undefined || v === '' ? '' : formatINR(v as string));
export const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
/** a - b for quantities, without float dust (0.1 + 0.2 style). */
export const sub = (a: unknown, b: unknown) => Number((Number(a ?? 0) - Number(b ?? 0)).toFixed(3));
export const date = (v: unknown) => formatDate(v ? String(v) : '');
/** An address on one line, as the printed documents show it. */
export const addr = (a: any) => (a ? [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ') : '');
export const dateTime = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const SHORT_FORMS = /\b(hr|upi|gst|qc|neft|rtgs|imps|emi)\b/gi;
export const label = (v: unknown) =>
  String(v ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).replace(SHORT_FORMS, (w) => w.toUpperCase());

// ---- the page frame and its messages -----------------------------------------
/**
 * A screen. A list or a report is a title with its buttons beside it. A record (an order, a lead, a
 * product) also passes `status` and `smart`, and is laid out the same way everywhere:
 *
 *   Title ............................ smart buttons (its related records, with counts)
 *   What can be done now (actions) ... where it stands (the status strip)
 */
export function Page({ title, actions, status, smart, children }: {
  title: string; actions?: ReactNode; status?: ReactNode; smart?: ReactNode; children: ReactNode;
}) {
  if (status === undefined && smart === undefined) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>{title}</h1>
          <div className="actions no-print">{actions}</div>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="page record">
      <div className="page-head">
        <h1>{title}</h1>
        {smart ? <div className="smart-buttons no-print">{smart}</div> : null}
      </div>
      <div className="record-bar no-print">
        <div className="actions">{actions}</div>
        {status}
      </div>
      {children}
    </div>
  );
}

/**
 * Where a record stands, as a strip of stages: the ones passed are filled in, the current one is
 * the brand colour, the rest wait. A record that left the road (cancelled, lost) ends in red.
 */
export function StatusBar({ steps, current, stopped, onPick }: {
  steps: string[]; current: number; stopped?: string | null;
  /** When given, the other stages are buttons: clicking one moves the record there (the screen asks first if it must). */
  onPick?: (index: number) => void;
}) {
  return (
    <ol className={onPick ? 'statusbar pickable' : 'statusbar'} aria-label="Where it stands">
      {steps.map((st, i) => (
        <li key={st} className={stopped ? 'todo' : i < current ? 'done' : i === current ? 'now' : 'todo'}
          aria-current={!stopped && i === current ? 'step' : undefined}>
          {onPick && (stopped || i !== current) ? <button type="button" title={`Move to ${st}`} onClick={() => onPick(i)}>{st}</button> : st}
        </li>
      ))}
      {stopped ? <li className="stopped" aria-current="step">{stopped}</li> : null}
    </ol>
  );
}

/** A related record or list, with a count: "Invoices 2", "In stock 14". Opens it. */
export function SmartButton({ icon, value, label: l, href, onClick, tone }: {
  icon: string; value: ReactNode; label: string; href?: string | null; onClick?: () => void; tone?: 'red' | 'amber' | 'green';
}) {
  const body = (
    <>
      <Icon name={icon} size={18} />
      <span><span className={`smart-value${tone ? ` ${tone}` : ''}`}>{value}</span><span className="smart-label">{l}</span></span>
    </>
  );
  if (onClick) return <button type="button" className="smart" onClick={onClick}>{body}</button>;
  if (!href) return <span className="smart">{body}</span>;
  return href.startsWith('#') ? <a className="smart" href={href}>{body}</a> : <Link className="smart" href={href}>{body}</Link>;
}

/**
 * Cards above a list that are also its filters: "3 To confirm", "2 To deliver". The chosen one is
 * outlined; choosing it again shows everything.
 */
export function CountCards<T extends string>({ cards, value, onChange }: {
  cards: { key: T; label: string; count: number | null | undefined; tone?: 'red' | 'amber' | 'green' }[];
  value: T | ''; onChange: (v: T | '') => void;
}) {
  return (
    <div className="counters no-print" role="group" aria-label="Show only">
      {cards.map((c) => (
        <button key={c.key} type="button" className={`counter${c.tone ? ` ${c.tone}` : ''}`} aria-pressed={value === c.key}
          onClick={() => onChange(value === c.key ? '' : c.key)}>
          <span className="counter-value">{c.count ?? '·'}</span>
          <span className="counter-label">{c.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Tabs across the top of a record's details. The screen shows the chosen tab's part itself. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs no-print" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : undefined}
          onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

export function Notice({ children }: { children: ReactNode }) {
  return children ? <div className="notice">{children}</div> : null;
}

/** While a screen's data is on its way: grey bars that shimmer where the content will be. */
export function Loading({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <ErrorBox error={error} />;
  if (!loading) return null;
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      <span style={{ width: '38%' }} /><span /><span /><span style={{ width: '72%' }} />
    </div>
  );
}

/**
 * A part that slides open and shut (a menu section). Its real height is measured and animated to,
 * then left free, so whatever it holds is never cut off; shut, it cannot be tabbed into.
 */
export function Collapse({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Drawn shut or open from the start, so nothing flashes; after that, only moved by the effect below.
  const [startOpen] = useState(open);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current) { first.current = false; return; }
    // Once open, the height is let go, so the part can grow or shrink with what it holds.
    const end = (e: TransitionEvent) => { if (e.propertyName === 'height' && open) el.style.height = 'auto'; };
    el.style.height = `${open ? 0 : el.scrollHeight}px`;
    void el.offsetHeight; // the starting height takes effect before the change, so it animates
    el.style.height = `${open ? el.scrollHeight : 0}px`;
    el.addEventListener('transitionend', end);
    return () => el.removeEventListener('transitionend', end);
  }, [open]);
  return (
    <div ref={ref} id={id} className={`collapse${className ? ` ${className}` : ''}`} data-open={open} inert={!open}
      style={startOpen ? undefined : { height: 0 }}>
      {children}
    </div>
  );
}

/**
 * Keeps something on screen for a moment after it is closed, so it can animate away instead of
 * vanishing: `mounted` says whether to draw it, `closing` whether it is on its way out.
 */
export function usePresence(open: boolean, ms = 160) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

const TONES: Record<string, string> = {
  new: 'blue', contacted: 'blue', interested: 'amber', meeting_booked: 'amber', converted: 'green', lost: 'red',
  draft: 'grey', confirmed: 'blue', delivered: 'amber', invoiced: 'green', cancelled: 'red',
  issued: 'green', paid: 'green', partly_paid: 'amber', unpaid: 'red', posted: 'green',
  sent: 'blue', partly_received: 'amber', received: 'amber', inwarded: 'green', closed: 'grey',
  pending: 'amber', approved: 'green', rejected: 'red',
  matched: 'green', unmatched: 'amber', ignored: 'grey', switched_off: 'grey', imported: 'green', failed: 'red', left_alone: 'grey', out: 'amber', all_back: 'green',
  taken_in: 'green', needs_a_look: 'red', waiting: 'amber',
  applied: 'blue', shortlisted: 'blue', interview: 'amber', offered: 'amber', hired: 'green',
  open: 'blue', in_progress: 'amber', on_hold: 'amber', done: 'green', skipped: 'red', scheduled: 'blue', completed: 'green', no_show: 'red',
  pass: 'green', hold: 'amber', fail: 'red', active: 'green', left: 'grey', planned: 'grey',
  present: 'green', half_day: 'amber', absent: 'red', leave: 'blue', weekly_off: 'grey', holiday: 'grey',
  in_use: 'green', under_repair: 'amber', retired: 'grey', overdue: 'red', due_soon: 'amber', on_track: 'green', off: 'grey',
};

export function Badge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value);
  return <span className={`badge ${TONES[v] ?? 'grey'}`}>{label(v)}</span>;
}

// ---- tables ---------------------------------------------------------------
export type Column<T> = {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  align?: 'right';
};

/**
 * How a list can also be drawn: what names each bar, slice or point, and what is measured. Rows that
 * share a name are added together, so a list of expenses can be drawn as spending by category.
 */
export type ChartSpec<T> = {
  /** bar: amounts side by side; donut: parts of a whole; line: a measure over dates (label is YYYY-MM-DD). */
  kind: 'bar' | 'donut' | 'line';
  label: (row: T) => string;
  value: (row: T) => number;
  format?: (v: number) => string;
  /** What is measured: the line's name and the words in the middle of the donut. */
  name?: string;
  /** Which view opens first, until the person picks one (remembered per screen). */
  first?: 'table' | 'chart';
  /** Bars beyond this many are added up as "Others". */
  top?: number;
};

function ChartOf<T>({ spec, rows }: { spec: ChartSpec<T>; rows: T[] }) {
  const format = spec.format ?? count;
  const sums = new Map<string, number>();
  for (const r of rows) {
    const key = spec.label(r) || '—';
    sums.set(key, (sums.get(key) ?? 0) + (Number(spec.value(r)) || 0));
  }
  const entries = [...sums.entries()];
  if (spec.kind === 'line') {
    const points = entries.map(([d, value]) => ({ date: d, value })).sort((a, b) => a.date.localeCompare(b.date));
    return <LineChart points={points} name={spec.name ?? 'Value'} format={format} />;
  }
  if (spec.kind === 'donut') return <Donut data={entries.map(([l, value]) => ({ label: l, value }))} format={format} caption={spec.name ?? 'Total'} />;
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const top = spec.top ?? 10;
  const shown: [string, number][] = sorted.length > top
    ? [...sorted.slice(0, top - 1), [`Others (${sorted.length - top + 1})`, sorted.slice(top - 1).reduce((t, [, v]) => t + v, 0)]]
    : sorted;
  return <BarList data={shown.map(([l, value]) => ({ label: l, value }))} format={format} />;
}

/** Table or chart: the choice is kept for this screen in this browser. */
/** A choice the screen keeps in this browser, such as how a list is shown; `first` until one is made. */
export function useRemembered<T extends string>(key: string, allowed: readonly T[], first: T) {
  const [value, setValue] = useState<T>(first);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && (allowed as readonly string[]).includes(saved)) setValue(saved as T);
    } catch { /* no storage: start from the default */ }
    // Read once per key; `allowed` is a fixed list at every call site.
  }, [key]);
  const choose = (v: T) => {
    setValue(v);
    try { localStorage.setItem(key, v); } catch { /* not kept, which is fine */ }
  };
  return [value, choose] as const;
}

const useView = (key: string, first: 'table' | 'chart') => useRemembered(key, ['table', 'chart'] as const, first);

/** Two or three ways to show the same thing (Board / List, Table / Chart), as one segmented control. */
export function ViewSwitch<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; icon: string }[];
}) {
  return (
    <div className="view-switch no-print" role="group" aria-label="Show as">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          <Icon name={o.icon} size={15} />{o.label}
        </button>
      ))}
    </div>
  );
}

export function Table<T extends Record<string, any>>({
  columns, rows, empty = 'Nothing here yet.', rowHref, footer, chart,
}: {
  columns: Column<T>[];
  rows: T[] | null | undefined;
  empty?: string;
  rowHref?: (row: T) => string | null;
  footer?: ReactNode;
  /** When given, a Table / Chart switch sits above the list. */
  chart?: ChartSpec<T>;
}) {
  const path = usePathname();
  const [view, setView] = useView(`radcore-view:${path}:${chart?.name ?? ''}`, chart?.first ?? 'table');
  if (!rows) return null;
  if (rows.length === 0) return <div className="empty"><span className="empty-icon"><Icon name="table" size={20} /></span><p>{empty}</p></div>;
  if (chart) {
    return (
      <>
        <div className="view-bar no-print">
          <div className="view-switch" role="group" aria-label="Show as">
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}><Icon name="table" size={15} />Table</button>
            <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}><Icon name="chart" size={15} />Chart</button>
          </div>
        </div>
        {view === 'chart'
          ? <div className="view-chart"><ChartOf spec={chart} rows={rows} /></div>
          : <Table columns={columns} rows={rows} empty={empty} rowHref={rowHref} footer={footer} />}
      </>
    );
  }
  return (
    <div className="table-wrap stack">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.align}>{c.title}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const href = rowHref?.(row);
            return (
              // Rows can share an id (the lines of one journal entry), so the position is part of the key.
              <tr key={`${row.id ?? 'row'}-${i}`}>
                {columns.map((c, ci) => {
                  const content = c.render ? c.render(row) : (row[c.key] as ReactNode);
                  return (
                    // On a phone each row is shown as a card, and the column title becomes the label beside the value.
                    <td key={c.key} className={c.align} data-label={c.title}>
                      {href && ci === 0 ? <Link href={href} className="row-link">{content}</Link> : content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

// ---- forms ----------------------------------------------------------------
export type Field = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'datetime-local' | 'select' | 'textarea' | 'checkbox' | 'password' | 'tel' | 'email' | 'file';
  /** For type 'file': what the file is (resume, bill, item_image), which decides who may open it. */
  purpose?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  help?: string;
  step?: string;
};

/**
 * Small schema-driven form. All validation that matters happens on the server; the form
 * just shows the server's message next to the button.
 */
export function Form({
  fields, initial = {}, submit = 'Save', onSubmit, onDone, inline,
}: {
  fields: Field[];
  initial?: Record<string, any>;
  submit?: string;
  onSubmit: (values: Record<string, any>) => Promise<unknown>;
  onDone?: (result: any) => void;
  inline?: boolean;
}) {
  const [values, setValues] = useState<Record<string, any>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A screen opened again first shows what it showed last time (lib/api.ts), then the fresh figures.
  // An edit form takes the fresh ones when they arrive, unless someone has already typed in it: it
  // must never save back what was there before.
  const touched = useRef(false);
  const initialKey = JSON.stringify(initial);
  const lastInitial = useRef(initialKey);
  useEffect(() => {
    if (initialKey === lastInitial.current) return;
    lastInitial.current = initialKey;
    if (!touched.current) setValues(initial);
    // Keyed on initialKey, not initial: the same values arrive as a new object on every render.
  }, [initialKey]);
  const set = (name: string, value: unknown) => {
    touched.current = true;
    setValues((v) => ({ ...v, [name]: value }));
  };

  async function handle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(values);
      setValues(initial);
      touched.current = false;
      onDone?.(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handle} className={inline ? 'form inline' : 'form'}>
      {fields.map((f) => (
        <label key={f.name} className={f.type === 'checkbox' ? 'check' : f.type === 'textarea' ? 'wide' : undefined}>
          {f.type !== 'checkbox' && <span>{f.label}{f.required ? ' *' : ''}</span>}
          {f.type === 'select' ? (
            <select value={values[f.name] ?? ''} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">—</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'file' ? (
            <UploadField purpose={f.purpose ?? 'other'} value={values[f.name] ?? ''} onChange={(url) => set(f.name, url)} />
          ) : f.type === 'textarea' ? (
            <textarea value={values[f.name] ?? ''} required={f.required} placeholder={f.placeholder} rows={2}
              onChange={(e) => set(f.name, e.target.value)} />
          ) : f.type === 'checkbox' ? (
            <>
              <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />
              <span>{f.label}</span>
            </>
          ) : (
            <input type={f.type ?? 'text'} value={values[f.name] ?? ''} required={f.required} placeholder={f.placeholder}
              step={f.step ?? (f.type === 'number' ? 'any' : undefined)} inputMode={f.type === 'tel' ? 'numeric' : undefined}
              onChange={(e) => set(f.name, e.target.value)} />
          )}
          {f.help ? <small className="muted">{f.help}</small> : null}
        </label>
      ))}
      <div className="form-foot">
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : submit}</button>
        <ErrorBox error={error} />
      </div>
    </form>
  );
}

/**
 * Attach a file (PDF or picture). It is uploaded as soon as it is chosen; the form then carries
 * the link to it. Works on a phone too, where "choose file" offers the camera.
 */
export function UploadField({ purpose, value, onChange }: { purpose: string; value: string; onChange: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const limitMb = useContext(SessionContext)?.max_upload_mb ?? 10;

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    // Said here, before sending: some hosts turn an oversized file away without a readable reason.
    if (file.size > limitMb * 1024 * 1024) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The most that can be attached here is ${limitMb} MB.`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/files?purpose=${encodeURIComponent(purpose)}`, {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? (res.status === 413 ? `That file is too large. The most that can be attached here is ${limitMb} MB.` : `Upload failed (${res.status})`));
      setName(json.data.name);
      onChange(json.data.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (value) {
    return (
      <span className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={value} target="_blank" rel="noreferrer">{name ?? 'View the attached file'}</a>
        <button type="button" onClick={() => { setName(null); onChange(''); }}>Remove</button>
      </span>
    );
  }
  return (
    <>
      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy}
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      <small className="muted">{busy ? 'Uploading…' : `PDF or a photo, up to ${limitMb} MB`}</small>
      {error ? <small className="error small">{error}</small> : null}
    </>
  );
}

// ---- buttons and small layout pieces ----------------------------------------
/** A button that runs an action, shows the server's error, and can ask for confirmation first. */
export function ActionButton({
  children, onClick, confirm, onDone, kind, disabled,
}: {
  children: ReactNode;
  onClick: () => Promise<unknown>;
  confirm?: string;
  onDone?: (result: any) => void;
  kind?: 'primary' | 'danger';
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="action">
      <button type="button" className={kind} disabled={busy || disabled}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            onDone?.(await onClick());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>
        {busy ? 'Working…' : children}
      </button>
      {error ? <span className="error small">{error}</span> : null}
    </span>
  );
}

/**
 * A pop-up over the screen, for what must be filled in or decided before going on. It is the
 * browser's own <dialog>: the keyboard stays inside it and Esc closes it. A click beside it does
 * not close it, so a half-filled form is never lost by accident. Show it with {open && <Modal …/>}.
 */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  // Closed by its × or Esc, it first plays its closing animation, then tells the screen.
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 150);
  };
  return (
    <dialog className={`modal${wide ? ' wide' : ''}${closing ? ' closing' : ''}`} aria-labelledby={titleId}
      ref={(d) => { if (d && !d.open) d.showModal(); }}
      onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}>×</button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/** A form in a pop-up: it says which boxes must be filled, and closes once saved. */
export function FormModal({ title, onClose, intro, wide, ...form }: {
  title: string; onClose: () => void; intro?: ReactNode; wide?: boolean;
} & Parameters<typeof Form>[0]) {
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      {intro}
      {form.fields.some((f) => f.required) ? <p className="muted small">Boxes marked * must be filled in.</p> : null}
      <Form {...form} onDone={(result) => { form.onDone?.(result); onClose(); }} />
    </Modal>
  );
}

export function Card({ title, children, actions, id }: { title?: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {title ? <div className="card-head"><h2>{title}</h2><div className="actions no-print">{actions}</div></div> : null}
      {children}
    </section>
  );
}

/** A headline figure: an icon, the number, what it is, and a line under it. With href the whole tile opens that screen. */
export function Stat({ label: l, value, hint, icon, tone, href }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: string; tone?: 'green' | 'amber' | 'red'; href?: string;
}) {
  const body = (
    <>
      {icon ? <Icon name={icon} size={26} className={tone ? `stat-icon ${tone}` : 'stat-icon'} /> : null}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{l}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </>
  );
  return href ? <Link href={href} className="stat">{body}</Link> : <div className="stat">{body}</div>;
}

/** Collapsible "add new" panel used on list pages. */
export function Toggle({ label: l, children, open: initialOpen = false }: { label: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="toggle no-print">
      <button type="button" onClick={() => setOpen(!open)}>{open ? '× Close' : l}</button>
      {open ? <div className="toggle-body">{children}</div> : null}
    </div>
  );
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

/** Download what is on screen (with the same filters) as an Excel file or as CSV. */
export function CsvLink({ href }: { href: string }) {
  const sep = href.includes('?') ? '&' : '?';
  return (
    <>
      <a className="button" href={`/api${href}${sep}format=xlsx&limit=5000`}>Excel</a>
      <a className="button" href={`/api${href}${sep}format=csv&limit=5000`}>CSV</a>
    </>
  );
}
