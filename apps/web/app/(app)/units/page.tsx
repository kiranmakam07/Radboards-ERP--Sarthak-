'use client';

import { useState } from 'react';
import { UNIT_STATUSES } from '@radcore/shared';
import { Badge, CsvLink, Loading, Page, Table, Tabs, date, label } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

type Tab = 'all' | 'in_stock' | 'charge';

/**
 * Every unit kept by serial number (vehicles, battery packs, motors): find one by its serial or
 * BPAN, see where each is and what state it is in, and the batteries late for a storage charge.
 * A unit's own page shows what it is made of and everything that happened to it.
 */
export default function UnitsPage() {
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('charge') ? 'charge' : 'all'));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useGet<{ data: any[] }>(tab !== 'charge' ? `/units${qs({ q, status, in_stock: tab === 'in_stock' ? 'true' : undefined, limit: 500 })}` : null);
  const due = useGet<{ data: any[] }>('/units/charge-due');
  const late = due.data?.data ?? [];

  return (
    <Page title="Units by serial" actions={<CsvLink href={tab === 'charge' ? '/units/charge-due' : '/units'} />}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'all', label: 'All units' }, { key: 'in_stock', label: 'On the shelf' },
        { key: 'charge', label: late.length ? `Storage charge due (${late.length})` : 'Storage charge due' },
      ]} />
      <div key={tab} className="tab-panel">
        {tab === 'charge' ? (
          <>
            <p className="muted">Batteries need a storage charge every so many days (set on the product). These are due or late; open one and record its charge.</p>
            <Loading loading={due.loading} error={due.error} />
            <Table rows={late} rowHref={(r) => `/units/${r.id}`} empty="No battery is due a charge." columns={[
              { key: 'serial_no', title: 'Serial' }, { key: 'item_name', title: 'Item' }, { key: 'location', title: 'Where' },
              { key: 'last_charged', title: 'Last charged', render: (r) => date(r.last_charged) },
              { key: 'due_on', title: 'Due on', render: (r) => date(r.due_on) },
              { key: 'days_late', title: 'Days late', align: 'right', render: (r) => (r.days_late > 0 ? <span className="error small">{r.days_late}</span> : 'today') },
            ]} />
          </>
        ) : (
          <>
            <div className="filters">
              <input placeholder="Serial, BPAN, or the vehicle it is in" value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="">Any status</option>
                {UNIT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </div>
            <Loading loading={list.loading} error={list.error} />
            <Table rows={list.data?.data} rowHref={(r) => `/units/${r.id}`}
              empty="No units yet. They come in by serial at Inward & QC, as opening stock, or are recorded inside a vehicle." columns={[
              { key: 'serial_no', title: 'Serial', render: (r) => <strong>{r.serial_no}</strong> },
              { key: 'item_name', title: 'Item', render: (r) => `${r.sku} — ${r.item_name}` },
              { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
              { key: 'location', title: 'Where', render: (r) => r.location ?? (r.parent_serial ? <span className="muted">in {r.parent_serial}</span> : '') },
              { key: 'components', title: 'Parts inside', align: 'right', render: (r) => (r.components ? r.components : '') },
              { key: 'batch_no', title: 'Batch' }, { key: 'bpan', title: 'BPAN' },
              { key: 'sold_on', title: 'Sold', render: (r) => date(r.sold_on) },
            ]} />
          </>
        )}
      </div>
    </Page>
  );
}
