'use client';

import { useState } from 'react';
import { ActionButton, Badge, Card, Form, Loading, Page, Table, Toggle } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const PLACEHOLDERS: [string, string][] = [
  ['{first_name}', "the lead's first name"], ['{name}', 'their full name'], ['{products}', 'what they asked about'],
  ['{my_name}', 'whoever is sending'], ['{company}', 'the company name'],
];
const sample = (body: string) => body
  .replace(/\{first_name\}/g, 'Asha').replace(/\{name\}/g, 'Asha Rao').replace(/\{products\}/g, 'Cruiser Board 27"')
  .replace(/\{my_name\}/g, 'Amit').replace(/\{company\}/g, 'Radboards');

/** Ready-made messages the sales team sends in one tap from a lead's page. */
export default function QuickRepliesPage() {
  const can = useCan();
  const manage = can('crm:manage');
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/crm/templates');
  const [editId, setEditId] = useState<string | null>(null);
  const editing = data?.data.find((t) => t.id === editId);
  const fields = [
    { name: 'name', label: 'Name on the button', required: true },
    { name: 'sort_order', label: 'Position', type: 'number' as const, step: '1' },
    { name: 'body', label: 'Message', type: 'textarea' as const, required: true },
  ];

  return (
    <Page title="Quick replies">
      <p className="muted">Messages that are written once and sent with the lead's own details filled in. They appear as buttons on every lead's page.</p>
      <Card title="What you can put in a message">
        <p className="small">{PLACEHOLDERS.map(([p, what]) => <span key={p} style={{ marginRight: 14 }}><code>{p}</code> {what}</span>)}</p>
      </Card>
      {manage && (
        <Toggle label="+ New quick reply">
          <Form submit="Save" fields={fields} onSubmit={(v) => post('/crm/templates', v)} onDone={reload} />
        </Toggle>
      )}
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No quick replies yet." columns={[
        { key: 'name', title: 'Button', render: (r) => (manage ? <button type="button" className="link" onClick={() => setEditId(editId === r.id ? null : r.id)}>{r.name}</button> : r.name) },
        { key: 'body', title: 'How it reads for a lead called Asha', render: (r) => <span style={{ whiteSpace: 'normal' }}>{sample(r.body)}</span> },
        { key: 'active', title: 'Status', render: (r) => <Badge value={r.active ? 'active' : 'off'} /> },
        { key: 'actions', title: '', render: (r) => (manage
          ? <ActionButton onClick={() => patch(`/crm/templates/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton> : null) },
      ]} />
      {editing && (
        <Card title={`Edit: ${editing.name}`}>
          <Form key={editing.updated_at} submit="Save changes"
            initial={{ name: editing.name, sort_order: editing.sort_order, body: editing.body }}
            fields={fields}
            onSubmit={(v) => patch(`/crm/templates/${editing.id}`, v)}
            onDone={() => { setEditId(null); reload(); }} />
        </Card>
      )}
    </Page>
  );
}
