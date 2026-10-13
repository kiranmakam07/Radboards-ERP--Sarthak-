'use client';

import { useState } from 'react';
import { ErrorBox, Loading, Page, label } from '@/components/ui';
import { api, useGet } from '@/lib/api';

// What each part of a permission's name means, in the words used on the screens.
const AREAS: Record<string, string> = {
  users: 'Users', settings: 'Setup', masters: 'Master lists', audit: 'Audit trail', items: 'Items', pricelists: 'Price lists', parties: 'Parties',
  leads: 'Leads', crm: 'Lead sources and quick replies', sales: 'Quotes and orders', quickbill: 'Quick bill', invoices: 'Invoices',
  purchasing: 'Purchasing', po: 'Purchase orders', grn: 'Goods receipts and QC', bills: 'Purchase bills', stock: 'Stock', payments: 'Payments',
  expenses: 'Expenses', accounts: 'Books and reports', gst: 'GST', dashboard: 'Dashboard', hr: 'HR', payroll: 'Payroll', ops: 'Operations',
};
const ACTIONS: Record<string, string> = {
  read: 'see', write: 'add and change', manage: 'manage', approve: 'approve', adjust: 'cancel and credit', create: 'make',
  override_credit: 'go over a credit limit',
};
// The masters need saying in full: who may add one while working is not who may change one afterwards.
const IN_FULL: Record<string, string> = {
  'masters:manage': 'Masters: the Masters screen, the small lists, and the download of everything',
  'items:write': 'Items master: add and change items',
  'parties:write': 'Parties: add a new customer or supplier while working',
  'parties:manage': 'Parties master: change one, its price list, credit limit and terms',
  'employees:manage': 'Employees master: add and change, salary, bank account and sign-in',
};
const describe = (key: string) => {
  if (IN_FULL[key]) return IN_FULL[key];
  const [area, action] = key.split(':') as [string, string];
  return area === 'dashboard' ? `${label(action)} dashboard` : `${AREAS[area] ?? label(area)}: ${ACTIONS[action] ?? label(action)}`;
};

/** Who can do what. Ticking or unticking a box changes it at once; the change is in the audit trail. */
export default function PermissionsPage() {
  const { data, loading, error, reload } = useGet<{ roles: string[]; data: any[] }>('/settings/permissions');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const roles = (data?.roles ?? []).filter((r) => r !== 'admin');

  async function save(key: string, next: string[]) {
    setBusy(key);
    setProblem(null);
    try {
      await api(`/settings/permissions/${key}`, { method: 'PUT', body: { roles: next } });
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page title="Permissions">
      <p className="muted">
        Each row is something that can be done; each column is a role. A change takes effect the next time that person opens a screen.
        The admin role can always do everything, so the system cannot be locked shut from here.
      </p>
      <Loading loading={loading && !data} error={error} />
      <ErrorBox error={problem} />
      {data && (
        <div className="table-wrap">
          <table className="load-grid">
            <thead>
              <tr><th>Permission</th><th></th>{roles.map((r) => <th key={r}>{label(r)}</th>)}<th>Admin</th></tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <tr key={p.key}>
                  <td>{describe(p.key)} <span className="muted small">{p.key}</span></td>
                  <td>
                    {p.changed ? (
                      <button type="button" disabled={busy === p.key} title="Back to how it was set up originally"
                        onClick={() => save(p.key, p.default_roles.filter((r: string) => r !== 'admin'))}>Reset</button>
                    ) : null}
                  </td>
                  {roles.map((r) => {
                    const on = p.roles.includes(r);
                    const wasOn = p.default_roles.includes(r);
                    return (
                      <td key={r} className={on !== wasOn ? 'load l1' : undefined} title={on !== wasOn ? 'Changed from the original setting' : undefined}>
                        <input type="checkbox" checked={on} disabled={busy === p.key} style={{ width: 'auto' }}
                          aria-label={`${label(r)}: ${describe(p.key)}`}
                          onChange={() => save(p.key, on ? p.roles.filter((x: string) => x !== r) : [...p.roles, r])} />
                      </td>
                    );
                  })}
                  <td><input type="checkbox" checked disabled style={{ width: 'auto' }} aria-label={`Admin: ${describe(p.key)} (always)`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Boxes with a tinted background differ from the original setting.</p>
    </Page>
  );
}
