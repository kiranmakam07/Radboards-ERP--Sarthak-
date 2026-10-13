'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BarList, ChartCard } from '@/components/charts';
import { ActionButton, Badge, Card, ErrorBox, Loading, Notice, Page, Stat, Table, dateTime } from '@/components/ui';
import { post, useGet } from '@/lib/api';

const CHANNELS: Record<string, string> = { meta: 'Meta lead ads', google: 'Google Ads', whatsapp: 'WhatsApp' };

function Ready({ ok, children }: { ok: boolean; children: string }) {
  return <span className={`badge ${ok ? 'green' : 'red'}`} style={{ marginRight: 6 }}>{ok ? '✓' : '✗'} {children}</span>;
}

function Address({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="small" style={{ margin: '6px 0' }}>
      <code style={{ overflowWrap: 'anywhere' }}>{url}</code>{' '}
      <button type="button" onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
    </p>
  );
}

/**
 * Where enquiries come from and whether each source is connected. Everything that arrives is
 * listed at the bottom; anything that could not be turned into a lead says why and can be retried.
 */
export default function LeadSourcesPage() {
  const { data, loading, error, reload } = useGet<{ data: any }>('/crm/integrations');
  const [origin, setOrigin] = useState('https://your-domain');
  const [notice, setNotice] = useState<string | null>(null);
  // What Meta itself said when last asked: which Page and which number the tokens belong to.
  const [checked, setChecked] = useState<any | null>(null);
  const [days, setDays] = useState('30');
  const [pulled, setPulled] = useState<any | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  const d = data?.data;
  const of = (channel: string) => d?.by_channel.find((c: any) => c.channel === channel);
  const failed = d ? d.events.filter((e: any) => e.status === 'failed' || e.status === 'received').length : 0;
  const metaReady = d && d.meta.app_secret && d.meta.verify_token;

  return (
    <Page title="Lead sources" actions={
      <>
        <ActionButton onClick={() => post('/crm/integrations/check')} onDone={(r) => { setChecked(r.data); reload(); }}>Check the connections</ActionButton>
        {failed > 0 ? (
          <ActionButton kind="primary" onClick={() => post('/crm/integrations/retry')}
            onDone={(r) => { setNotice(`${r.data.processed} became leads, ${r.data.failed} still could not.`); reload(); }}>Try the failed ones again</ActionButton>
        ) : null}
      </>
    }>
      <p className="muted">Every enquiry, wherever it comes from, lands in the same lead list: checked against existing phone numbers, given an owner and a first follow-up.</p>
      <Loading loading={loading && !d} error={error} />
      <Notice>{notice}</Notice>
      {d && (
        <>
          <div className="stats">
            <Stat label="From Meta ads, 30 days" value={of('meta')?.leads ?? 0} hint={of('meta') ? `last ${dateTime(of('meta').last_event_at)}` : 'nothing received yet'} />
            <Stat label="From Google ads, 30 days" value={of('google')?.leads ?? 0} hint={of('google') ? `last ${dateTime(of('google').last_event_at)}` : 'nothing received yet'} />
            <Stat label="From WhatsApp, 30 days" value={of('whatsapp')?.leads ?? 0} hint={of('whatsapp') ? `last ${dateTime(of('whatsapp').last_event_at)}` : 'nothing received yet'} />
            <Stat label="Needs a look" value={failed ? <span style={{ color: 'var(--danger)' }}>{failed}</span> : 0} hint="could not become a lead" />
          </div>

          <div className="grid">
            <Card title="Meta lead ads (Facebook and Instagram)">
              <p><Ready ok={d.meta.app_secret}>App secret</Ready><Ready ok={d.meta.verify_token}>Verify token</Ready><Ready ok={d.meta.page_access_token}>Page access token</Ready></p>
              <p className="small">A lead form filled in on Facebook or Instagram becomes a lead here within seconds, with the campaign it came from.</p>
              <p className="muted small">Callback address to give Meta (Webhooks → Page → <code>leadgen</code>):</p>
              <Address url={`${origin}/api/hooks/meta`} />
              <p className="muted small">The three values are set on the server (<code>META_APP_SECRET</code>, <code>META_VERIFY_TOKEN</code>, <code>META_PAGE_ACCESS_TOKEN</code>). Until then this address refuses everything.</p>
              <p className="small">{d.state?.meta_verified_at ? <>Meta accepted this address on {dateTime(d.state.meta_verified_at)}.</> : <span className="muted">Meta has not checked this address yet (it does when the webhook is subscribed).</span>}</p>
              {checked?.meta && (
                <div className="small" style={{ margin: '6px 0' }}>
                  {checked.meta.page ? <p>The page access token belongs to the Page <strong>{checked.meta.page.name}</strong>.</p> : null}
                  {checked.meta.page && checked.meta.leadgen_subscribed === true ? <p><Ready ok>The Page sends its lead forms to this app</Ready></p> : null}
                  {checked.meta.page && checked.meta.leadgen_subscribed === false ? <p><Ready ok={false}>The Page does not send its lead forms to this app yet</Ready><span className="muted"> Subscribe the Page to the app with the <code>leadgen</code> field.</span></p> : null}
                  {!d.meta.page_access_token ? <p className="muted">Nothing to ask Meta until the page access token is set.</p> : null}
                  <ErrorBox error={checked.meta.problem} />
                </div>
              )}
              {d.meta.page_access_token && (
                <div style={{ borderTop: '1px solid var(--line, #ddd)', marginTop: 10, paddingTop: 10 }}>
                  <p className="small"><strong>Leads already in the lead forms.</strong> Bring in the ones from before the connection was made, or any missed while something was down. A lead that is already here is not added again.</p>
                  <span className="actions">
                    <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="How far back">
                      <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
                    </select>
                    <ActionButton onClick={() => post('/crm/integrations/meta/fetch', { days: Number(days) })} onDone={(r) => { setPulled(r.data); reload(); }}>Bring them in</ActionButton>
                  </span>
                  {pulled && (
                    <Notice>
                      {pulled.found} lead(s) in {pulled.forms} form(s): {pulled.leads} taken in, {pulled.already_here} were already here
                      {pulled.not_usable ? `, ${pulled.not_usable} could not be used (listed below with the reason)` : ''}.
                      {pulled.more ? ' There are more: press again to take the next lot.' : ''}
                    </Notice>
                  )}
                </div>
              )}
            </Card>

            <Card title="WhatsApp Business">
              <p><Ready ok={Boolean(metaReady)}>Connected to the Meta app</Ready></p>
              <p className="small">The first message from a new number starts a lead; later messages go on that lead's timeline. A message that came from a Click-to-WhatsApp ad carries the ad's name.</p>
              <p className="muted small">Callback address (Webhooks → WhatsApp Business Account → <code>messages</code>):</p>
              <Address url={`${origin}/api/hooks/whatsapp`} />
              <p><Ready ok={Boolean(d.whatsapp?.send)}>Sending from the app</Ready></p>
              <p className="small">{d.state?.whatsapp_verified_at ? <>Meta accepted this address on {dateTime(d.state.whatsapp_verified_at)}.</> : <span className="muted">Meta has not checked this address yet.</span>}</p>
              {checked?.whatsapp?.number ? <p className="small">Sending is connected to <strong>{checked.whatsapp.number.phone}</strong>{checked.whatsapp.number.name ? ` (${checked.whatsapp.number.name})` : ''}{checked.whatsapp.number.quality ? `, quality ${String(checked.whatsapp.number.quality).toLowerCase()}` : ''}.</p> : null}
              <ErrorBox error={checked?.whatsapp?.problem} />
              <p className="muted small">This needs the business number to be on WhatsApp's Cloud API. Until sending is connected (<code>WHATSAPP_PHONE_NUMBER_ID</code> and <code>WHATSAPP_ACCESS_TOKEN</code> on the server), a quick reply on the lead's page opens WhatsApp with the message written.</p>
            </Card>

            <Card title="Google Ads lead forms" actions={<Link href="/campaigns">Campaign links</Link>}>
              <p className="small">In the lead form asset in Google Ads, under "Lead delivery option → Webhook", enter this address and, as the key, the key of one of your campaign links.</p>
              <Address url={`${origin}/api/hooks/google-ads`} />
              <Table rows={d.campaign_links.filter((c: any) => c.source_name === 'Google Ads')} empty="Make a campaign link with the source Google Ads; its key goes into Google Ads." columns={[
                { key: 'name', title: 'Campaign link', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.name}</span> },
                { key: 'token', title: 'Key', render: (r) => <code style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{r.token}</code> },
              ]} />
            </Card>

            <Card title="Website and other forms" actions={<Link href="/campaigns">Campaign links</Link>}>
              <p className="small">Any form or tool that can send a web request: post <code>name</code>, <code>phone</code> and, if you have them, <code>email</code> and <code>message</code> to a campaign link's address.</p>
              <Table rows={d.campaign_links.filter((c: any) => c.source_name !== 'Google Ads')} empty="No campaign links yet." columns={[
                { key: 'name', title: 'Campaign link', render: (r) => <>{r.name} <span className="muted small">{r.source_name}</span></> },
                { key: 'token', title: 'Address', render: (r) => <code style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{origin}/api/hooks/form/{r.token}</code> },
              ]} />
            </Card>

            <ChartCard title="Leads that came in by themselves, last 30 days">
              <BarList empty="Nothing has come in through a connection yet."
                data={d.by_channel.map((c: any) => ({ label: CHANNELS[c.channel] ?? c.channel, value: c.leads, note: c.failed ? `${c.failed} not usable` : undefined }))} />
            </ChartCard>
          </div>

          <Card title="What has come in">
            <Table rows={d.events} empty="Nothing received yet. Once a source is connected, every enquiry it sends is listed here." columns={[
              { key: 'created_at', title: 'When', render: (r) => dateTime(r.created_at) },
              { key: 'channel', title: 'From', render: (r) => CHANNELS[r.channel] ?? r.channel },
              { key: 'summary', title: 'Who', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.summary}</span> },
              { key: 'status', title: 'Result', render: (r) => (r.status === 'processed' ? <span className="badge green">Lead</span> : r.status === 'failed' ? <span className="badge red">Not usable</span> : <Badge value={r.status} />) },
              { key: 'error', title: 'Why not', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.error}</span> },
              { key: 'lead_no', title: 'Lead', render: (r) => (r.lead_id ? <Link href={`/leads/${r.lead_id}`}>{r.lead_no}</Link> : '') },
              { key: 'actions', title: '', render: (r) => (r.status === 'failed' || r.status === 'received'
                ? <ActionButton onClick={() => post(`/crm/events/${r.id}/ignore`)} onDone={reload} confirm="Set this aside? It will not be tried again.">Set aside</ActionButton> : null) },
            ]} />
          </Card>
        </>
      )}
    </Page>
  );
}
