'use client';

import { ROLES } from '@radcore/shared';
import { ActionButton, Badge, Card, Form, Loading, Page, Table, Toggle, label } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useSession } from '@/lib/session';

const roleOptions = ROLES.map((r) => ({ value: r, label: label(r) }));

export default function UsersPage() {
  const { user } = useSession();
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/users');
  return (
    <Page title="Users">
      <Toggle label="+ Add user">
        <Form submit="Create user"
          fields={[
            { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone (used to sign in)', type: 'tel', required: true },
            { name: 'email', label: 'Email', type: 'email' }, { name: 'role', label: 'Role', type: 'select', required: true, options: roleOptions },
            { name: 'password', label: 'Password (min 8 characters)', type: 'password', required: true },
          ]}
          onSubmit={(v) => post('/users', v)} onDone={reload} />
      </Toggle>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} columns={[
        { key: 'name', title: 'Name' }, { key: 'phone', title: 'Phone' }, { key: 'email', title: 'Email' },
        { key: 'role', title: 'Role', render: (r) => label(r.role) },
        { key: 'active', title: 'Status', render: (r) => <Badge value={r.active ? 'approved' : 'closed'} /> },
        { key: 'x', title: '', render: (r) => (r.id === user.id ? <span className="muted small">you</span> : (
          <ActionButton confirm={r.active ? `Deactivate ${r.name}? They will be signed out.` : undefined}
            onClick={() => patch(`/users/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Deactivate' : 'Reactivate'}</ActionButton>
        )) },
      ]} />
      <div className="grid" style={{ marginTop: 14 }}>
        <Card title="Change a user's role or reset their password">
          <Form submit="Update"
            fields={[
              { name: 'id', label: 'User', type: 'select', required: true, options: (data?.data ?? []).filter((u) => u.id !== user.id).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })) },
              { name: 'role', label: 'New role (optional)', type: 'select', options: roleOptions },
              { name: 'password', label: 'New password (optional)', type: 'password' },
            ]}
            onSubmit={({ id, role, password }) => patch(`/users/${id}`, { ...(role ? { role } : {}), ...(password ? { password } : {}) })} onDone={reload} />
        </Card>
        <Card title="Change my password">
          <Form submit="Change password"
            fields={[
              { name: 'current_password', label: 'Current password', type: 'password', required: true },
              { name: 'new_password', label: 'New password (min 8 characters)', type: 'password', required: true },
            ]}
            onSubmit={(v) => post('/auth/change-password', v)} onDone={() => { window.location.href = '/login'; }} />
        </Card>
      </div>
    </Page>
  );
}
