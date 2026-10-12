'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, Loading, Notice, Page, Stat, Table, dateTime } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const CHANNELS: Record<string, string> = { shopify: 'Shopify', amazon: 'Amazon', flipkart: 'Flipkart' };
const STATUS: Record<string, string> = { processed: 'taken_in', failed: 'needs_a_look', received: 'waiting', ignored: 'ignored' };

/** Pick an order report from Amazon or Flipkart and take its orders in. */
function ImportReport({ onDone }: { onDone: (message: string) => void }) {
  const [channel, setChannel] = useState('amazon');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post('/sales/online/import', { channel, file: await file.text() });
      const d = r.data;
      onDone([
        `${d.orders} ${d.orders === 1 ? 'order' : 'orders'} in the file: ${d.taken_in} taken in`,
        d.already_here ? `${d.already_here} already here` : null,
        d.could_not ? `${d.could_not} could not be taken in (see below)` : null,
        d.left_out ? `${d.left_out} cancelled or returned rows left out` : null,
      ].filter(Boolean).join(', ') + '.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="filters">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Which marketplace the report is from">
          <option value="amazon">Amazon order report</option>
          <option value="flipkart">Flipkart order report</option>
        </select>
        <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" disabled={busy} aria-label="The order report file"
          onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} />
        {busy ? <span className="muted small">Reading the file…</span> : null}
      </div>
      <ErrorBox error={error} />
      <p className="muted small" style={{ marginBottom: 0 }}>
        Download the order report from the seller site (as it comes, without editing) and choose it here. Sending a report that overlaps
        an earlier one is safe: an order already here is not taken in again.
      </p>
    </>
  );
}

/**
 * Orders from the online store and the marketplaces. Each one arrives as a confirmed sales order,
 * so stores deliver it and accounts invoice it like any other. What could not be taken in says why.
 */
export default function OnlineOrdersPage() {
  const { data, loading, error, reload } = useGet<{ data: any }>('/sales/online');
  const can = useCan();
  const write = can('sales:write');
  const [origin, setOrigin] = useState('https://your-domain');
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const d = data?.data;
  const of = (channel: string) => d?.by_channel.find((c: any) => c.channel === channel);
  const stuck = d ? d.events.filter((e: any) => e.status === 'failed' || e.status === 'received').length : 0;
  const hook = `${origin}/api/hooks/shopify`;

  return (
    <Page title="Online orders" actions={write && stuck > 0 ? (
      <ActionButton kind="primary" onClick={() => post('/sales/online/retry')}
        onDone={(r) => { setNotice(`${r.data.processed} taken in, ${r.data.failed} still could not be.`); reload(); }}>Try the stuck ones again</ActionButton>
    ) : null}>
      <p className="muted">
        An order placed on Shopify, Amazon or Flipkart becomes a confirmed sales order here, matched to our items by SKU.
        From there it is delivered and invoiced under <Link href="/sales/orders">Quotes &amp; orders</Link> like any other order.
      </p>
      <Loading loading={loading && !d} error={error} />
      <Notice>{notice}</Notice>
      {d && (
        <>
          <div className="stats">
            {Object.entries(CHANNELS).map(([key, name]) => (
              <Stat key={key} label={`${name}, 30 days`} value={of(key)?.orders ?? 0}
                hint={of(key) ? `${of(key).to_deliver} to deliver · ${of(key).to_invoice} to invoice` : 'nothing received yet'} />
            ))}
            <Stat label="Needs a look" value={stuck ? <span style={{ color: 'var(--danger)' }}>{stuck}</span> : 0} hint="could not be taken in" />
          </div>

          <div className="grid">
            <Card title="Shopify">
              <p><span className={`badge ${d.shopify.connected ? 'green' : 'red'}`}>{d.shopify.connected ? '✓ Connected' : '✗ Not connected yet'}</span></p>
              <p className="small">Each new order arrives by itself within seconds, and a cancellation cancels the order here if the goods have not left.</p>
              <p className="muted small">Address to give Shopify (Settings → Notifications → Webhooks, for “Order creation” and “Order cancellation”, format JSON):</p>
              <p className="small" style={{ margin: '6px 0' }}>
                <code style={{ overflowWrap: 'anywhere' }}>{hook}</code>{' '}
                <button type="button" onClick={() => navigator.clipboard.writeText(hook).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
              </p>
              {!d.shopify.connected ? <p className="muted small">Shopify shows a signing key under the webhooks; an admin sets it on the server as <code>SHOPIFY_WEBHOOK_SECRET</code>.</p> : null}
            </Card>
            <Card title="Amazon and Flipkart">
              {write ? <ImportReport onDone={(message) => { setNotice(message); reload(); }} /> : <p className="muted">Someone who handles sales brings the order reports in here.</p>}
            </Card>
          </div>

          <Card title="What has come in">
            <Table rows={d.events} empty="No online orders yet." columns={[
              { key: 'created_at', title: 'Received', render: (e) => dateTime(e.created_at) },
              { key: 'channel', title: 'From', render: (e) => <>{CHANNELS[e.channel] ?? e.channel}{e.event_type === 'cancelled' ? <span className="muted small"> · cancellation</span> : null}</> },
              { key: 'summary', title: 'Order', render: (e) => <span style={{ whiteSpace: 'normal' }}>{e.summary ?? '—'}</span> },
              { key: 'status', title: 'Status', render: (e) => (
                <span style={{ whiteSpace: 'normal' }}>
                  <Badge value={STATUS[e.status] ?? e.status} />
                  {e.error ? <span className="small" style={{ display: 'block', color: e.status === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>{e.error}</span> : null}
                </span>
              ) },
              { key: 'order_no', title: 'Sales order', render: (e) => (e.order_id ? <Link href={`/sales/orders/${e.order_id}`}>{e.order_no}</Link> : '') },
              { key: 'x', title: '', render: (e) => (write && (e.status === 'failed' || e.status === 'received') ? (
                <ActionButton confirm="Set this one aside? It will not be taken in." onClick={() => post(`/sales/online/events/${e.id}/ignore`)} onDone={reload}>Set aside</ActionButton>
              ) : null) },
            ]} />
          </Card>
        </>
      )}
    </Page>
  );
}
