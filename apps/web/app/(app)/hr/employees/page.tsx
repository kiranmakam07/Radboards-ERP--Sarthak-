'use client';

import { useState } from 'react';
import { EMPLOYMENT_TYPES } from '@radcore/shared';
import { Badge, CsvLink, Form, Loading, Page, Table, Toggle, date, inr, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function EmployeesPage() {
  const can = useCan();
  const [f, setF] = useState({ q: '', status: 'active' });
  const path = `/hr/employees${qs(f)}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  const users = useGet<{ data: any[] }>('/masters/users-lite');

  return (
    <Page title="Employees" actions={<CsvLink href={path} />}>
      {can('hr:write') && (
        <Toggle label="+ Add employee">
          <p className="muted small">For people already working here. A new joiner is added by pressing Hire on their application.</p>
          <Form submit="Save employee"
            initial={{ employment_type: 'full_time' }}
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'phone', label: 'Phone', type: 'tel', required: true },
              { name: 'email', label: 'Email', type: 'email' },
              { name: 'department', label: 'Department', required: true },
              { name: 'designation', label: 'Designation', required: true },
              { name: 'employment_type', label: 'Type', type: 'select', required: true, options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: label(t) })) },
              { name: 'join_date', label: 'Joining date', type: 'date', required: true },
              { name: 'monthly_salary', label: 'Salary (per month)', type: 'number' },
              { name: 'user_id', label: 'Their sign-in', type: 'select', help: 'If they use RadCore', options: (users.data?.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
            ]}
            onSubmit={(v) => post('/hr/employees', v)}
            onDone={reload} />
        </Toggle>
      )}
      <div className="filters">
        <input placeholder="Search name, number, phone" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="active">On the rolls</option><option value="left">Left</option><option value="">Everyone</option>
        </select>
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
    </Page>
  );
}
