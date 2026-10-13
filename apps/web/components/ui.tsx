'use client';

import Link from 'next/link';
import { useContext, useState, type FormEvent, type ReactNode } from 'react';
import { formatDate, formatINR } from '@radcore/shared';
import { SessionContext } from '@/lib/session';

export const inr = (v: unknown) => (v === null || v === undefined || v === '' ? '' : formatINR(v as string));
export const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
/** a - b for quantities, without float dust (0.1 + 0.2 style). */
export const sub = (a: unknown, b: unknown) => Number((Number(a ?? 0) - Number(b ?? 0)).toFixed(3));
export const date = (v: unknown) => formatDate(v ? String(v) : '');
export const dateTime = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const SHORT_FORMS = /\b(hr|upi|gst|qc|neft|rtgs|imps|emi)\b/gi;
export const label = (v: unknown) =>
  String(v ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).replace(SHORT_FORMS, (w) => w.toUpperCase());

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
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

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

export function Notice({ children }: { children: ReactNode }) {
  return children ? <div className="notice">{children}</div> : null;
}

export function Loading({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <ErrorBox error={error} />;
  return loading ? <p className="muted">Loading…</p> : null;
}

const TONES: Record<string, string> = {
  new: 'blue', contacted: 'blue', interested: 'amber', meeting_booked: 'amber', converted: 'green', lost: 'red',
  draft: 'grey', confirmed: 'blue', delivered: 'amber', invoiced: 'green', cancelled: 'red',
  issued: 'green', paid: 'green', partly_paid: 'amber', unpaid: 'red', posted: 'green',
  sent: 'blue', partly_received: 'amber', received: 'amber', inwarded: 'green', closed: 'grey',
  pending: 'amber', approved: 'green', rejected: 'red',
  matched: 'green', unmatched: 'amber', ignored: 'grey', switched_off: 'grey', imported: 'green', failed: 'red', left_alone: 'grey',
  taken_in: 'green', needs_a_look: 'red', waiting: 'amber',
  applied: 'blue', shortlisted: 'blue', interview: 'amber', offered: 'amber', hired: 'green',
  open: 'blue', on_hold: 'amber', done: 'green', skipped: 'red', scheduled: 'blue', completed: 'green', no_show: 'red',
  pass: 'green', hold: 'amber', fail: 'red', active: 'green', left: 'grey', planned: 'grey',
  present: 'green', half_day: 'amber', absent: 'red', leave: 'blue', weekly_off: 'grey', holiday: 'grey',
  in_use: 'green', under_repair: 'amber', retired: 'grey', overdue: 'red', due_soon: 'amber', on_track: 'green', off: 'grey',
};

export function Badge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value);
  return <span className={`badge ${TONES[v] ?? 'grey'}`}>{label(v)}</span>;
}

export type Column<T> = {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  align?: 'right';
};

export function Table<T extends Record<string, any>>({
  columns, rows, empty = 'Nothing here yet.', rowHref, footer,
}: {
  columns: Column<T>[];
  rows: T[] | null | undefined;
  empty?: string;
  rowHref?: (row: T) => string | null;
  footer?: ReactNode;
}) {
  if (!rows) return null;
  if (rows.length === 0) return <p className="muted">{empty}</p>;
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
              <tr key={row.id ?? i}>
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
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));

  async function handle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(values);
      setValues(initial);
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

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title ? <div className="card-head"><h2>{title}</h2><div className="actions no-print">{actions}</div></div> : null}
      {children}
    </section>
  );
}

export function Stat({ label: l, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{l}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
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
