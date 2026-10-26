'use client';

import { useState } from 'react';
import { ActionButton, Card, FormModal, Loading, Page, Table, num } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Warranty rules (months, and km or charge-cycle limits, per item: a vehicle or a component) and the fault codes. */
export default function ServiceSetupPage() {
  const can = useCan();
  const approver = can('service:approve');
  const rules = useGet<{ data: any[] }>('/service/warranty-rules');
  const codes = useGet<{ data: any[] }>('/service/fault-codes');
  const items = useGet<{ data: any[] }>(approver ? '/items?limit=2000' : null);
  const [open, setOpen] = useState<'rule' | 'code' | null>(null);
  return (
    <Page title="Warranty and fault codes">
      <Card title="Warranty rules" actions={approver ? <button type="button" onClick={() => setOpen('rule')}>+ Rule</button> : null}>
        <Loading loading={rules.loading} error={rules.error} />
        <Table rows={rules.data?.data} empty="No rules yet: without one, nothing of that item is under warranty." columns={[
          { key: 'item_name', title: 'Item', render: (r) => <>{r.item_name} <span className="muted small">{r.sku}</span></> },
          { key: 'months', title: 'Months', align: 'right' },
          { key: 'km_limit', title: 'Up to km', align: 'right', render: (r) => (r.km_limit ? num(r.km_limit) : '') },
          { key: 'cycle_limit', title: 'Up to charge cycles', align: 'right', render: (r) => (r.cycle_limit ? num(r.cycle_limit) : '') },
        ]} />
        <p className="muted small" style={{ marginTop: 8 }}>Counted from the day the unit was sold. A component (a battery pack) has a rule of its own. A new rule for an item replaces the old one.</p>
      </Card>
      <Card title="Fault codes" actions={approver ? <button type="button" onClick={() => setOpen('code')}>+ Fault code</button> : null}>
        <Loading loading={codes.loading} error={codes.error} />
        <Table rows={codes.data?.data} empty="No fault codes yet." columns={[
          { key: 'code', title: 'Code', render: (c) => <strong>{c.code}</strong> }, { key: 'component', title: 'Component' }, { key: 'description', title: 'What' },
          { key: 'active', title: '', render: (c) => (approver ? (
            <ActionButton onClick={() => patch(`/service/fault-codes/${c.id}`, { active: !c.active })} onDone={codes.reload}>{c.active ? 'Switch off' : 'Switch on'}</ActionButton>
          ) : (c.active ? '' : 'Off')) },
        ]} />
      </Card>
      {open === 'rule' ? (
        <FormModal title="Warranty rule" submit="Save" onClose={() => setOpen(null)} onDone={rules.reload}
          fields={[
            { name: 'item_id', label: 'Item', type: 'select', required: true, options: (items.data?.data ?? []).filter((i) => i.is_stock_item).map((i) => ({ value: i.id, label: `${i.sku} — ${i.name}` })) },
            { name: 'months', label: 'Months', type: 'number', required: true },
            { name: 'km_limit', label: 'Up to km (optional)', type: 'number' }, { name: 'cycle_limit', label: 'Up to charge cycles (optional)', type: 'number' },
          ]}
          onSubmit={(v) => post('/service/warranty-rules', { item_id: v.item_id, months: v.months, km_limit: v.km_limit || null, cycle_limit: v.cycle_limit || null })} />
      ) : null}
      {open === 'code' ? (
        <FormModal title="Fault code" submit="Save" onClose={() => setOpen(null)} onDone={codes.reload}
          fields={[{ name: 'code', label: 'Code', required: true }, { name: 'component', label: 'Component', required: true }, { name: 'description', label: 'What it means', required: true }]}
          onSubmit={(v) => post('/service/fault-codes', v)} />
      ) : null}
    </Page>
  );
}
