'use client';

import { Card, Form, Page } from '@/components/ui';
import { post } from '@/lib/api';

export default function AccountPage() {
  return (
    <Page title="My password">
      <Card>
        <p className="muted">Changing your password signs you out everywhere.</p>
        <Form submit="Change password"
          fields={[
            { name: 'current_password', label: 'Current password', type: 'password', required: true },
            { name: 'new_password', label: 'New password (min 8 characters)', type: 'password', required: true },
          ]}
          onSubmit={(v) => post('/auth/change-password', v)} onDone={() => { window.location.href = '/login'; }} />
      </Card>
    </Page>
  );
}
