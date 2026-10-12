'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ActionButton, Card, ErrorBox, Notice, Table, UploadField, dateTime } from '@/components/ui';
import { api, post, useGet } from '@/lib/api';

/**
 * Contact a lead in one tap. Picking a quick reply opens WhatsApp with the message already
 * written for this lead; the contact is logged, a New lead becomes Contacted, and the lead is
 * left with a next follow-up so it cannot be forgotten.
 */
export function QuickReplies({ leadId, phone, onDone }: { leadId: string; phone: string; onDone: () => void }) {
  const templates = useGet<{ data: any[] }>('/crm/templates');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<any>(null);

  async function contact(channel: 'whatsapp' | 'call', templateId: string | null) {
    // The new tab is opened in the click itself (browsers block one opened later), then pointed at WhatsApp.
    const tab = channel === 'whatsapp' ? window.open('', '_blank') : null;
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/crm/leads/${leadId}/contact`, { channel, template_id: templateId ?? '' });
      if (tab) tab.location.href = res.data.whatsapp_url;
      else if (channel === 'call') window.location.href = `tel:${phone}`;
      setLast({ ...res.data, channel });
      onDone();
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = (templates.data?.data ?? []).filter((t) => t.active);
  return (
    <Card title="Contact in one tap">
      <div className="filters" style={{ marginBottom: 6 }}>
        {active.map((t) => (
          <button key={t.id} type="button" className="primary" disabled={busy} title={t.body} onClick={() => contact('whatsapp', t.id)}>WhatsApp: {t.name}</button>
        ))}
        <button type="button" disabled={busy} onClick={() => contact('whatsapp', null)}>WhatsApp, blank message</button>
        <button type="button" disabled={busy} onClick={() => contact('call', null)}>Call</button>
      </div>
      <p className="muted small">The message is written for this lead and opens in WhatsApp for you to send. The contact is logged and a follow-up is set.</p>
      <ErrorBox error={error} />
      <Notice>
        {last ? (
          <>
            Logged. Stage: {last.stage_label}{last.next_follow_up_at ? `, next follow-up ${dateTime(last.next_follow_up_at)}` : ''}.
            {last.channel === 'whatsapp' ? <> If WhatsApp did not open, <a href={last.whatsapp_url} target="_blank" rel="noreferrer">open it here</a>.</> : null}
          </>
        ) : null}
      </Notice>
    </Card>
  );
}

const SCORE_TONE: Record<string, string> = { hot: 'red', warm: 'amber', cold: 'grey' };

/** How likely the lead is to buy: the word and the number, never the colour alone. */
export function Score({ score, label }: { score: number | null | undefined; label: string | null | undefined }) {
  if (score === null || score === undefined || !label) return null;
  return <span className={`badge ${SCORE_TONE[label] ?? 'grey'}`} title="How likely this lead is to buy, out of 100">{label[0]!.toUpperCase() + label.slice(1)} {score}</span>;
}

const POINTS: [string, string][] = [
  ['stage', 'How far it has come'], ['interest', 'What it wants'], ['contact', 'Talking to us this week'],
  ['fresh', 'How recent it is'], ['repeat', 'Has bought before'],
];

/** The points behind a lead's score, so nobody has to take the number on trust. */
export function ScoreCard({ lead }: { lead: { score: number | null; score_label: string | null; score_points: Record<string, number> | null } }) {
  if (lead.score === null || !lead.score_points) return null;
  return (
    <Card title="Chance of buying" actions={<Score score={lead.score} label={lead.score_label} />}>
      <dl className="kv">
        {POINTS.map(([key, name]) => (
          <div key={key}><dt>{name}</dt><dd>{lead.score_points![key]! > 0 ? '+' : ''}{lead.score_points![key]}</dd></div>
        ))}
      </dl>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Out of 100, from what is on record: the stage, the items asked about, calls and messages in the last week, how new the lead is,
        and whether this phone number has bought before. 60 and over is hot, 35 to 59 warm.
      </p>
    </Card>
  );
}

type NewLead = { id: string; lead_no: string; name: string; source_name: string; source_detail: string | null; mine: boolean };
type Opened = { id: string; title: string; lead_id: string; name: string; lead_no: string };

/**
 * A notice the moment a lead arrives: asked for every half minute while the app is open. Shown on
 * the page, and as a notification from the browser as well once the person has allowed those
 * (which is what reaches them when the app is in the background or installed on a phone).
 */
export function LeadAlerts() {
  const [shown, setShown] = useState<NewLead[]>([]);
  const [opened, setOpened] = useState<Opened[]>([]);
  const [canAsk, setCanAsk] = useState(false);
  const since = useRef<string | null>(null);

  useEffect(() => {
    setCanAsk(typeof Notification !== 'undefined' && Notification.permission === 'default');
    let stopped = false;
    async function look() {
      try {
        const res = await api<{ data: NewLead[]; opened: Opened[]; now: string }>(`/leads/alerts${since.current ? `?since=${encodeURIComponent(since.current)}` : ''}`);
        if (stopped) return;
        since.current = res.now;
        if (res.opened.length > 0) {
          setOpened((old) => [...res.opened.filter((o) => !old.some((x) => x.id === o.id)), ...old].slice(0, 5));
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            for (const o of res.opened) {
              const n = new Notification(`${o.name} opened "${o.title}"`, { body: 'A good moment to call.', tag: o.id, icon: '/icon-192.png' });
              n.onclick = () => { window.focus(); window.location.href = `/leads/${o.lead_id}`; };
            }
          }
        }
        if (res.data.length === 0) return;
        setShown((old) => [...res.data.filter((l) => !old.some((o) => o.id === l.id)), ...old].slice(0, 5));
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          for (const l of res.data) {
            const n = new Notification(`New lead: ${l.name}`, { body: [l.source_name, l.source_detail].filter(Boolean).join(' · '), tag: l.id, icon: '/icon-192.png' });
            n.onclick = () => { window.focus(); window.location.href = `/leads/${l.id}`; };
          }
        }
      } catch {
        // Offline for a moment, or signed out: the next look tries again.
      }
    }
    void look();
    const timer = window.setInterval(look, 30_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  if (shown.length === 0 && opened.length === 0) return null;
  return (
    <div className="alerts no-print" role="status" aria-live="polite">
      {shown.map((l) => (
        <div className="alert" key={l.id}>
          <div>
            <strong>New lead{l.mine ? ' for you' : ''}: {l.name}</strong>
            <div className="small muted">{[l.source_name, l.source_detail].filter(Boolean).join(' · ')} · {l.lead_no}</div>
          </div>
          <Link className="button primary" href={`/leads/${l.id}`} onClick={() => setShown((old) => old.filter((o) => o.id !== l.id))}>Open</Link>
          <button type="button" aria-label={`Dismiss the notice about ${l.name}`} onClick={() => setShown((old) => old.filter((o) => o.id !== l.id))}>×</button>
        </div>
      ))}
      {opened.map((o) => (
        <div className="alert" key={o.id}>
          <div>
            <strong>{o.name} opened “{o.title}”</strong>
            <div className="small muted">A good moment to call · {o.lead_no}</div>
          </div>
          <Link className="button primary" href={`/leads/${o.lead_id}`} onClick={() => setOpened((old) => old.filter((x) => x.id !== o.id))}>Open</Link>
          <button type="button" aria-label={`Dismiss the notice about ${o.name}`} onClick={() => setOpened((old) => old.filter((x) => x.id !== o.id))}>×</button>
        </div>
      ))}
      {canAsk ? (
        <button type="button" className="link small" onClick={() => Notification.requestPermission().then(() => setCanAsk(false))}>
          Also tell me when RadCore is in the background
        </button>
      ) : null}
    </div>
  );
}

/**
 * Send a file to the lead (a price list, a brochure) through a link of its own, and see whether
 * they have opened it. The link goes out by WhatsApp from the person's own phone or computer.
 */
export function ShareFiles({ leadId, phone, name, canSend }: { leadId: string; phone: string; name: string; canSend: boolean }) {
  const { data, reload } = useGet<{ data: any[] }>(`/leads/${leadId}/shares`);
  const earlier = useGet<{ data: any[] }>(canSend ? '/leads/shared-files' : null);
  const [title, setTitle] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ title: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const digits = phone.replace(/\D/g, '');
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  const link = (token: string) => `${window.location.origin}/s/${token}`;
  const message = (t: string, url: string) => `Hi ${firstName}, here is ${t}: ${url}`;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/leads/${leadId}/shares`, { title, file_url: fileUrl });
      setMade({ title: res.data.title, url: link(res.data.token) });
      setCopied(false);
      setTitle('');
      setFileUrl('');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shares = data?.data ?? [];
  if (!canSend && shares.length === 0) return null;
  return (
    <Card title="Files sent">
      {canSend && (
        <>
          <div className="form" style={{ marginBottom: 10 }}>
            <label>What it is
              <input value={title} placeholder="e.g. Price list, October" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>The file
              <UploadField purpose="share" value={fileUrl} onChange={setFileUrl} />
            </label>
            {(earlier.data?.data ?? []).length > 0 && !fileUrl ? (
              <label>Or one sent before
                <select value="" onChange={(e) => {
                  const f = earlier.data!.data.find((x) => x.file_id === e.target.value);
                  if (f) { setFileUrl(`/api/files/${f.file_id}`); if (!title) setTitle(f.title); }
                }}>
                  <option value="">Choose…</option>
                  {earlier.data!.data.map((f) => <option key={f.file_id} value={f.file_id}>{f.title}</option>)}
                </select>
              </label>
            ) : null}
            <div className="form-foot">
              <button type="button" className="primary" disabled={busy || !title.trim() || !fileUrl} onClick={send}>{busy ? 'Making the link…' : 'Make the link'}</button>
              <span className="muted small">You will see here when they open it.</span>
            </div>
          </div>
          <ErrorBox error={error} />
          {made ? (
            <div className="notice">
              <strong>{made.title}</strong> is ready to send:{' '}
              <code style={{ overflowWrap: 'anywhere' }}>{made.url}</code>
              <div className="actions" style={{ marginTop: 8 }}>
                <a className="button primary" href={`https://wa.me/${digits}?text=${encodeURIComponent(message(made.title, made.url))}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
                <button type="button" onClick={() => navigator.clipboard.writeText(made.url).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy the link'}</button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <Table rows={shares} empty="Nothing has been sent to this lead yet." columns={[
        { key: 'title', title: 'File', render: (r) => <a href={`/s/${r.token}`} target="_blank" rel="noreferrer">{r.title}</a> },
        { key: 'created_at', title: 'Sent', render: (r) => <>{dateTime(r.created_at)}{r.sent_by ? <span className="muted small"> · {r.sent_by}</span> : null}</> },
        { key: 'opened', title: 'Opened', render: (r) => (r.revoked_at ? <span className="badge grey">Link switched off</span>
          : r.view_count > 0 ? <><span className="badge green">Opened {r.view_count === 1 ? 'once' : `${r.view_count} times`}</span> <span className="muted small">last {dateTime(r.last_viewed_at)}</span></>
            : <span className="badge amber">Not opened yet</span>) },
        { key: 'x', title: '', render: (r) => (canSend && !r.revoked_at ? (
          <ActionButton confirm="Switch this link off? It will stop working for whoever has it." onClick={() => post(`/leads/shares/${r.id}/revoke`)} onDone={reload}>Switch off</ActionButton>
        ) : null) },
      ]} />
    </Card>
  );
}
