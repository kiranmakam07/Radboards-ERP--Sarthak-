'use client';

import { useState } from 'react';
import { ActionButton, Card, ErrorBox, Notice, Table, date } from '@/components/ui';
import { api, post, useGet } from '@/lib/api';

/** Bring a list of leads in from a spreadsheet saved as CSV. */
export function ImportLeads({ sources, users, onDone }: { sources: any[]; users: any[]; onDone: () => void }) {
  const [v, setV] = useState({ source_id: '', source_detail: '', owner_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  async function send(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await post('/leads/import', { ...v, csv: await file.text() });
      setResult(res.data);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted small">
        In Excel or Google Sheets, save the list as CSV. The first row names the columns: it needs a <strong>Phone</strong> (or Mobile) column,
        and can have Name, Email and Notes. A number that is already a lead is not added twice.
      </p>
      <div className="form">
        <label>Where these leads came from *
          <select value={v.source_id} onChange={(e) => setV({ ...v, source_id: e.target.value })}>
            <option value="">Choose…</option>{sources.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Campaign or event<input value={v.source_detail} placeholder="e.g. Pune expo, October" onChange={(e) => setV({ ...v, source_detail: e.target.value })} /></label>
        <label>Give them to
          <select value={v.owner_id} onChange={(e) => setV({ ...v, owner_id: e.target.value })}>
            <option value="">Share out among the sales team</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label>The file
          <input type="file" accept=".csv,text/csv,text/plain" disabled={busy || !v.source_id} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} />
          <small className="muted">{busy ? 'Bringing them in…' : v.source_id ? 'Choose the CSV file' : 'Choose where they came from first'}</small>
        </label>
      </div>
      <ErrorBox error={error} />
      {result ? (
        <Notice>
          {result.rows} {result.rows === 1 ? 'row' : 'rows'}: {result.added} added{result.already_here ? `, ${result.already_here} already here` : ''}
          {result.problems.length ? `, ${result.problems.length} could not be read` : ''}.
        </Notice>
      ) : null}
      {result?.problems.length ? <Table rows={result.problems} columns={[{ key: 'row', title: 'Row' }, { key: 'message', title: 'Problem' }]} /> : null}
    </>
  );
}

/**
 * What to do with the leads that are ticked: hand them all to one person, or message them one
 * after another with the same quick reply (each opens WhatsApp with the message written for that lead).
 */
export function BulkLeads({ picked, users, canAssign, onClear, onDone }: { picked: any[]; users: any[]; canAssign: boolean; onClear: () => void; onDone: () => void }) {
  const templates = useGet<{ data: any[] }>('/crm/templates');
  const [owner, setOwner] = useState('');
  const [reply, setReply] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = (templates.data?.data ?? []).filter((t) => t.active);

  async function message(lead: any) {
    // The new tab is opened in the click itself (browsers block one opened later), then pointed at WhatsApp.
    const tab = window.open('', '_blank');
    setError(null);
    try {
      const res = await post(`/crm/leads/${lead.id}/contact`, { channel: 'whatsapp', template_id: reply });
      if (tab) tab.location.href = res.data.whatsapp_url;
      setSent((s) => [...s, lead.id]);
      onDone();
    } catch (e) {
      tab?.close();
      setError(`${lead.name}: ${(e as Error).message}`);
    }
  }

  const left = picked.filter((l) => !sent.includes(l.id));
  return (
    <Card title={`${picked.length} ${picked.length === 1 ? 'lead' : 'leads'} ticked`} actions={<button type="button" onClick={onClear}>Untick all</button>}>
      <div className="filters">
        {canAssign ? (
          <>
            <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Who to give the ticked leads to">
              <option value="">Give them to…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <ActionButton disabled={!owner} onClick={() => post('/leads/bulk-assign', { ids: picked.map((l) => l.id), owner_id: owner })}
              onDone={(r) => { setNotice(`${r.data.moved} ${r.data.moved === 1 ? 'lead' : 'leads'} now with ${r.data.owner}.`); onDone(); }}>Hand over</ActionButton>
          </>
        ) : null}
        <select value={reply} onChange={(e) => { setReply(e.target.value); setSent([]); }} aria-label="Quick reply to send to the ticked leads">
          <option value="">Message them with…</option>{active.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <Notice>{notice}</Notice>
      <ErrorBox error={error} />
      {reply ? (
        <>
          <p className="muted small">One tap each: WhatsApp opens with the message written for that person, and the contact is logged. {left.length === 0 ? 'All done.' : `${left.length} to go.`}</p>
          <div className="filters" style={{ marginBottom: 0 }}>
            {picked.map((l) => (sent.includes(l.id)
              ? <span key={l.id} className="badge green">✓ {l.name}</span>
              : <button key={l.id} type="button" className={l.id === left[0]?.id ? 'primary' : undefined} onClick={() => message(l)}>Send to {l.name}</button>))}
          </div>
        </>
      ) : null}
    </Card>
  );
}

/** The follow-up plan a lead is on: every step with its day, the one that is next, and one tap to do it. */
export function PlanCard({ leadId, plan, phone, canChange, onDone }: { leadId: string; plan: any | null; phone: string; canChange: boolean; onDone: () => void }) {
  const plans = useGet<{ data: any[] }>(canChange && !plan ? '/leads/plans' : null);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const available = (plans.data?.data ?? []).filter((p) => p.active);
  if (!plan && (!canChange || available.length === 0)) return null;

  async function doStep(step: any) {
    const tab = step.template_id ? window.open('', '_blank') : null;
    setError(null);
    try {
      if (step.template_id) {
        const res = await post(`/crm/leads/${leadId}/contact`, { channel: 'whatsapp', template_id: step.template_id });
        if (tab) tab.location.href = res.data.whatsapp_url;
      } else {
        await post(`/leads/${leadId}/activities`, { type: 'call', note: step.what });
        window.location.href = `tel:${phone}`;
      }
      onDone();
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    }
  }

  if (!plan) {
    return (
      <Card title="Follow-up plan">
        <div className="filters" style={{ marginBottom: 0 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Follow-up plan to put this lead on">
            <option value="">Not on a plan. Put it on…</option>{available.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.steps.length} steps)</option>)}
          </select>
          <ActionButton disabled={!pick} onClick={() => post(`/leads/${leadId}/plan`, { plan_id: pick })} onDone={onDone}>Start</ActionButton>
        </div>
      </Card>
    );
  }
  return (
    <Card title={`Follow-up plan: ${plan.name}`} actions={canChange ? (
      <ActionButton confirm="Take this lead off the plan?" onClick={() => api(`/leads/${leadId}/plan`, { method: 'DELETE' })} onDone={onDone}>Stop the plan</ActionButton>
    ) : null}>
      <ol className="plan">
        {plan.steps.map((s: any, i: number) => (
          <li key={i} className={s.state}>
            <span className="dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
            <span>
              <strong>{s.what}</strong>
              <span className="muted small"> · {s.state === 'done' ? 'done' : `day ${s.after_days}, ${date(s.due_at)}`}{s.template_name ? ` · sends “${s.template_name}”` : ''}</span>
            </span>
            {s.state === 'now' && canChange ? (
              <button type="button" className="primary" onClick={() => doStep(s)}>{s.template_id ? 'Send it on WhatsApp' : 'Call and mark done'}</button>
            ) : null}
          </li>
        ))}
      </ol>
      <ErrorBox error={error} />
      <p className="muted small" style={{ marginBottom: 0 }}>Doing a step on or after its day moves the lead to the next one. The plan stops by itself if they reply on WhatsApp, buy, or are marked lost.</p>
    </Card>
  );
}
