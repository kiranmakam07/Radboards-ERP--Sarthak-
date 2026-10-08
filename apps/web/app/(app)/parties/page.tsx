'use client';

import { useState } from 'react';
import { STATE_CODES } from '@radcore/shared';
import { partyBody, partyFields } from '@/components/party-form';
import { Badge, CsvLink, Form, Loading, Page, Table, Toggle, inr } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function PartiesPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', type: '' });
  const path = `/parties${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const priceLists = useGet<{ data: any[] }>('/masters/price-lists');
  return (
    <Page title="Parties" actions={<CsvLink href={path} />}>
      {can('parties:write') && (
        <Toggle label="+ Add party">
          <Form fields={partyFields(priceLists.data?.data ?? [])} initial={{ party_type: 'customer' }}
            onSubmit={(v) => post('/parties', partyBody(v))} onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, phone, GSTIN" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        {['', 'customer', 'dealer', 'supplier'].map((t) => (
          <button key={t} type="button" className={f.type === t ? 'primary' : undefined} onClick={() => setF({ ...f, type: t })}>{t ? `${t[0]!.toUpperCase()}${t.slice(1)}s` : 'All'}</button>
        ))}
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/parties/${r.id}`} columns={[
        { key: 'name', title: 'Name' },
        { key: 'party_type', title: 'Type', render: (r) => <Badge value={r.party_type} /> },
        { key: 'phone', title: 'Phone' },
        { key: 'gstin', title: 'GSTIN' },
        { key: 'state_code', title: 'State', render: (r) => STATE_CODES[r.state_code] ?? r.state_code },
        { key: 'credit_limit', title: 'Credit limit', align: 'right', render: (r) => inr(r.credit_limit) },
        // Positive = they owe us; negative = we owe them / they have an advance.
        { key: 'balance', title: 'Balance', align: 'right', render: (r) => (Number(r.balance) === 0 ? '' : `${inr(Math.abs(Number(r.balance)))} ${Number(r.balance) > 0 ? 'Dr' : 'Cr'}`) },
      ]} />
    </Page>
  );
}
