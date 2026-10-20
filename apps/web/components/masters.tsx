'use client';

import { useState } from 'react';
import { EMPLOYMENT_TYPES, STATE_CODES } from '@radcore/shared';
import { partyBody, partyFields } from '@/components/party-form';
import { Badge, CsvLink, Form, Loading, Table, Toggle, date, inr, label, type Field } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * The masters: the set-up records every other screen reads from. Each list here is the same one
 * shown under Sales and HR; what differs is who may change it. Products have their own file
 * (components/products.tsx), because each also has a page of its own.
 */

/**
 * Customers and dealers, or suppliers, or all of them. Someone who sells or buys can add a new
 * one while working; the price list, credit limit and payment terms are for whoever keeps the master.
 */
export function PartiesMaster({ side, onChange }: { side?: 'customers' | 'suppliers'; onChange?: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ q: '', type: '', active: 'true' });
  const path = `/parties${qs({ ...f, side: side ?? '' })}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const priceLists = useGet<{ data: any[] }>('/masters/price-lists');
  const manage = can('parties:manage');
  const types = side === 'suppliers' ? ['supplier'] : side === 'customers' ? ['customer', 'dealer'] : ['customer', 'dealer', 'supplier'];
  const fields = partyFields(priceLists.data?.data ?? [], true, manage)
    .map((x) => (x.name === 'party_type' ? { ...x, options: (x.options ?? []).filter((o) => types.includes(String(o.value))) } : x));
  const noun = side === 'suppliers' ? 'supplier' : side === 'customers' ? 'customer' : 'party';

  return (
    <>
      {(manage || can('parties:write')) && (
        <Toggle label={`+ Add ${noun}`}>
          {!manage ? <p className="muted small">A price list, credit limit and payment terms are set afterwards by whoever keeps the masters.</p> : null}
          <Form fields={fields} initial={{ party_type: types[0] }}
            onSubmit={(v) => post('/parties', partyBody(v))} onDone={() => { reload(); onChange?.(); }} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, phone, GSTIN" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        {types.length > 1 && ['', ...types].map((t) => (
          <button key={t} type="button" className={f.type === t ? 'primary' : undefined} onClick={() => setF({ ...f, type: t })}>{t ? `${t[0]!.toUpperCase()}${t.slice(1)}s` : 'All'}</button>
        ))}
        <select value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })}>
          <option value="true">Active</option><option value="false">Switched off</option><option value="all">All</option>
        </select>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/parties/${r.id}`} columns={[
        { key: 'name', title: 'Name' },
        { key: 'party_type', title: 'Type', render: (r) => <Badge value={r.party_type} /> },
        { key: 'phone', title: 'Phone' },
        { key: 'gstin', title: 'GSTIN' },
        { key: 'state_code', title: 'State', render: (r) => STATE_CODES[r.state_code] ?? r.state_code },
        { key: 'price_list_name', title: 'Price list' },
        { key: 'credit_limit', title: 'Credit limit', align: 'right', render: (r) => inr(r.credit_limit) },
        { key: 'payment_terms_days', title: 'Terms', align: 'right', render: (r) => (r.payment_terms_days === null ? '' : `${r.payment_terms_days} days`) },
        // Positive = they owe us; negative = we owe them / they have an advance.
        { key: 'balance', title: 'Balance', align: 'right', render: (r) => (Number(r.balance) === 0 ? '' : `${inr(Math.abs(Number(r.balance)))} ${Number(r.balance) > 0 ? 'Dr' : 'Cr'}`) },
        { key: 'active', title: '', render: (r) => (r.active ? null : <Badge value="closed" />) },
      ]} />
    </>
  );
}

export const employeeFields = (users: any[]): Field[] => [
  { name: 'name', label: 'Name', required: true },
  { name: 'phone', label: 'Phone', type: 'tel', required: true },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'department', label: 'Department', required: true },
  { name: 'designation', label: 'Designation', required: true },
  { name: 'employment_type', label: 'Type', type: 'select', required: true, options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: label(t) })) },
  { name: 'join_date', label: 'Joining date', type: 'date', required: true },
  { name: 'monthly_salary', label: 'Salary (per month)', type: 'number' },
  { name: 'user_id', label: 'Their sign-in', type: 'select', help: 'If they use RadCore', options: users.map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
];

export function EmployeesMaster({ onChange }: { onChange?: () => void }) {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: 'active' });
  const path = `/hr/employees${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const users = useGet<{ data: any[] }>('/masters/users-lite');

  return (
    <>
      {can('employees:manage') && (
        <Toggle label="+ Add employee">
          <p className="muted small">For people already working here. A new joiner is added by pressing Hire on their application.</p>
          <Form submit="Save employee" initial={{ employment_type: 'full_time' }} fields={employeeFields(users.data?.data ?? [])}
            onSubmit={(v) => post('/hr/employees', v)} onDone={() => { reload(); onChange?.(); }} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, number, phone" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="active">On the rolls</option><option value="left">Left</option><option value="">Everyone</option>
        </select>
        <CsvLink href={path} />
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No employees match." rowHref={(r) => `/hr/employees/${r.id}`} columns={[
        { key: 'employee_no', title: 'No.' },
        { key: 'name', title: 'Name' },
        { key: 'department', title: 'Department' },
        { key: 'designation', title: 'Designation' },
        { key: 'phone', title: 'Phone' },
        { key: 'employment_type', title: 'Type', render: (r) => label(r.employment_type) },
        { key: 'join_date', title: 'Joined', render: (r) => date(r.join_date) },
        { key: 'monthly_salary', title: 'Salary', align: 'right', render: (r) => inr(r.monthly_salary) },
        { key: 'user_name', title: 'Sign-in', render: (r) => (r.user_name ? `${r.user_name} (${r.user_role})` : '') },
        { key: 'status', title: 'Status', render: (r) => <><Badge value={r.status} />{r.left_on ? <span className="muted small"> {date(r.left_on)}</span> : null}</> },
      ]} />
    </>
  );
}
