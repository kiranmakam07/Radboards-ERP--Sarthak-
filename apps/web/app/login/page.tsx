'use client';

import { InstallButton } from '@/components/install';
import { Form } from '@/components/ui';
import { post } from '@/lib/api';

export default function LoginPage() {
  return (
    <div className="center login">
      <div className="card">
        <div className="login-brand"><span className="brand-mark">R</span>RadCore</div>
        <p className="muted">Sign in with your phone number or email.</p>
        <Form
          submit="Sign in"
          fields={[
            { name: 'identifier', label: 'Phone or email', required: true },
            { name: 'password', label: 'Password', type: 'password', required: true },
          ]}
          onSubmit={(v) => post('/auth/login', v)}
          onDone={() => {
            // Only follow same-site paths, so a crafted link cannot bounce the user elsewhere after login.
            const next = new URLSearchParams(window.location.search).get('next');
            window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
          }}
        />
        <InstallButton className="install" />
      </div>
    </div>
  );
}
