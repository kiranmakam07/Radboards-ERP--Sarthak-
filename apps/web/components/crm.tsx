'use client';

import { useState } from 'react';
import { Card, ErrorBox, Notice, dateTime } from '@/components/ui';
import { post, useGet } from '@/lib/api';

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
