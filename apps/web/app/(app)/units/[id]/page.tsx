'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  ActionButton, Badge, Card, FormModal, KV, Loading, Page, SmartButton, StatusBar, Table, date, dateTime, label,
} from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Where a unit's life is along the way: on our shelf, then with the customer. */
const STEPS = ['In stock', 'Sold'];

/**
 * One unit: what it is (serial, BPAN, firmware, batch), where it is, what it sits in and what is
 * fitted inside it, all the way down (vehicle -> battery pack -> controller -> motor), and its
 * history. Stores record the parts inside it and a battery's storage charge here.
 */
export default function UnitPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const write = can('units:write');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/units/${id}`);
  const items = useGet<{ data: any[] }>(write ? '/items?limit=2000' : null);
  const [open, setOpen] = useState<'edit' | 'part' | null>(null);
  const u = data?.data;
  if (!u) return <Page title="Unit"><Loading loading={loading} error={error} /></Page>;
  const gone = ['sold', 'rtv', 'scrapped'].includes(u.status);
  const top = u.ancestors.at(-1);

  return (
    <Page title={`${u.item_name} ${u.serial_no}`}
      smart={
        <>
          <SmartButton icon="stores" value={u.location ?? (top ? `in ${top.serial_no}` : '—')} label={label(u.status)} />
          <SmartButton icon="trend" value={u.descendants.length} label="Parts inside" href="#parts" />
          {u.sold_invoice_id ? <SmartButton icon="accounts" value={u.sold_invoice_no} label={`Sold to ${u.sold_to}`} href={`/invoices/${u.sold_invoice_id}`} /> : null}
          {u.charge_every_days ? <SmartButton icon="calendar" value={u.last_charged_on ? date(u.last_charged_on) : 'Never'} label="Last storage charge" /> : null}
        </>
      }
      status={<StatusBar steps={STEPS} current={gone ? 1 : 0} stopped={u.status === 'scrapped' ? 'Scrapped' : u.status === 'rtv' ? 'Returned to supplier' : null} />}
      actions={write ? (
        <>
          <button type="button" onClick={() => setOpen('edit')}>Edit details</button>
          <button type="button" onClick={() => setOpen('part')}>+ Part inside</button>
          {u.charge_every_days && !gone ? (
            <ActionButton kind="primary" onClick={() => post(`/units/${id}/charged`, {})} onDone={reload}>Charged today</ActionButton>
          ) : null}
        </>
      ) : null}>
      <div className="grid">
        <Card title="What it is">
          <KV rows={[
            ['Item', <Link href={`/items/${u.item_id}`}>{u.sku} — {u.item_name}</Link>], ['Serial', <strong>{u.serial_no}</strong>],
            ['Status', <Badge value={u.status} />], ['Where', u.location ?? (top ? <Link href={`/units/${top.id}`}>inside {top.serial_no}</Link> : null)],
            ['BPAN', u.bpan], ['Firmware', u.firmware_version], ['Made on', date(u.mfg_date)],
            ['Batch', u.batch_no ? `${u.batch_no}${u.chemistry ? ` · ${u.chemistry}` : ''}${u.weight_kg ? ` · ${Number(u.weight_kg)} kg` : ''}` : null],
            ['Supplier', u.supplier_name], ['Sold on', date(u.sold_on)],
          ]} />
        </Card>
        <Card title="What it is made of" id="parts">
          <ul className="tree">
            {[...u.ancestors].reverse().map((a: any) => (
              <li key={a.id} className={a.depth === u.ancestors.length ? 'root' : undefined} style={{ '--depth': u.ancestors.length - a.depth } as React.CSSProperties}>
                <Link href={`/units/${a.id}`}>{a.item_name} {a.serial_no}</Link>
              </li>
            ))}
            <li className={u.ancestors.length ? undefined : 'root'} style={{ '--depth': u.ancestors.length } as React.CSSProperties}><strong>{u.item_name} {u.serial_no}</strong> (this one)</li>
            {u.descendants.map((d: any) => (
              <li key={d.id} style={{ '--depth': u.ancestors.length + d.depth } as React.CSSProperties}>
                <Link href={`/units/${d.id}`}>{d.item_name} {d.serial_no}</Link>
                {d.bpan ? <span className="muted small"> · BPAN {d.bpan}</span> : null}{d.firmware_version ? <span className="muted small"> · fw {d.firmware_version}</span> : null}
              </li>
            ))}
          </ul>
          {u.descendants.length === 0 && u.ancestors.length === 0 ? <p className="muted small">No parts recorded inside it. {write ? 'Add the battery pack, controller or motor with + Part inside.' : ''}</p> : null}
        </Card>
      </div>
      <Card title="History">
        <Table rows={u.events} empty="Nothing yet." columns={[
          { key: 'at', title: 'When', render: (r) => dateTime(r.at) },
          { key: 'event', title: 'What', render: (r) => label(r.event) },
          { key: 'move', title: 'From → to', render: (r) => [r.from_location, r.to_location].some(Boolean) ? `${r.from_location ?? '—'} → ${r.to_location ?? '—'}` : '' },
          { key: 'to_status', title: 'Status after', render: (r) => <Badge value={r.to_status} /> },
          { key: 'note', title: 'Note', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.note}</span> },
          { key: 'user_name', title: 'By' },
        ]} />
      </Card>

      {open === 'edit' ? (
        <FormModal title={`Edit ${u.serial_no}`} submit="Save" onClose={() => setOpen(null)} onDone={reload}
          initial={{ bpan: u.bpan ?? '', firmware_version: u.firmware_version ?? '', mfg_date: u.mfg_date ?? '' }}
          fields={[
            { name: 'bpan', label: 'BPAN (21 characters, battery packs)' },
            { name: 'firmware_version', label: 'Firmware version' },
            { name: 'mfg_date', label: 'Made on', type: 'date' },
          ]}
          onSubmit={(v) => patch(`/units/${id}`, v)} />
      ) : null}
      {open === 'part' ? (
        <FormModal title={`A part inside ${u.serial_no}`} submit="Record part" onClose={() => setOpen(null)} onDone={reload}
          intro={<p className="muted small">The battery pack, controller or motor fitted in this unit, with its own serial. It goes wherever this unit goes.</p>}
          fields={[
            { name: 'item_id', label: 'Part', type: 'select', required: true, options: (items.data?.data ?? []).filter((i) => i.is_serialised && i.id !== u.item_id).map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` })) },
            { name: 'serial_no', label: 'Serial', required: true },
            { name: 'bpan', label: 'BPAN (battery packs)' }, { name: 'firmware_version', label: 'Firmware version' },
            { name: 'batch_no', label: 'Batch no' }, { name: 'mfg_date', label: 'Made on', type: 'date' },
          ]}
          onSubmit={(v) => post(`/units/${id}/components`, v)} />
      ) : null}
    </Page>
  );
}
