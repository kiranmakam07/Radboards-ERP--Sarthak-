'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { post, useGet } from '@/lib/api';
import { SessionContext, type Session } from '@/lib/session';

type NavItem = { href: string; label: string; perm?: string };
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Me', items: [
    { href: '/my-work', label: 'My work' },
    { href: '/dashboards/owner', label: "Owner's summary", perm: 'dashboard:owner' },
  ] },
  { group: 'Store', items: [
    { href: '/walk-in', label: 'Walk-in', perm: 'leads:write' },
    { href: '/quick-bill', label: 'Quick bill', perm: 'quickbill:create' },
  ] },
  { group: 'CRM', items: [
    { href: '/leads/pipeline', label: 'Pipeline', perm: 'leads:read' },
    { href: '/leads', label: 'Leads', perm: 'leads:read' },
    { href: '/crm/sources', label: 'Lead sources', perm: 'crm:manage' },
    { href: '/campaigns', label: 'Campaign links', perm: 'leads:write' },
    { href: '/crm/replies', label: 'Quick replies', perm: 'leads:read' },
    { href: '/crm/spend', label: 'Ad spend', perm: 'crm:manage' },
    { href: '/dashboards/marketing', label: 'Marketing dashboard', perm: 'dashboard:marketing' },
  ] },
  { group: 'Sales', items: [
    { href: '/dashboards/sales', label: 'Sales dashboard', perm: 'dashboard:sales' },
    { href: '/sales/orders', label: 'Quotes & orders', perm: 'sales:read' },
    { href: '/invoices', label: 'Invoices', perm: 'invoices:read' },
    { href: '/parties', label: 'Parties', perm: 'parties:read' },
  ] },
  { group: 'Stores', items: [
    { href: '/dashboards/stores', label: 'Stores dashboard', perm: 'dashboard:stores' },
    { href: '/purchasing/orders', label: 'Purchase orders', perm: 'purchasing:read' },
    { href: '/purchasing/receipts', label: 'Inward & QC', perm: 'purchasing:read' },
    { href: '/stock', label: 'Stock', perm: 'stock:read' },
    { href: '/items', label: 'Items', perm: 'items:read' },
  ] },
  { group: 'Accounts', items: [
    { href: '/dashboards/accounts', label: 'Accounts dashboard', perm: 'dashboard:accounts' },
    { href: '/purchasing/bills', label: 'Purchase bills', perm: 'purchasing:read' },
    { href: '/payments', label: 'Payments', perm: 'payments:read' },
    { href: '/expenses', label: 'Expenses', perm: 'expenses:read' },
    { href: '/accounts/reports', label: 'Books & reports', perm: 'accounts:read' },
    { href: '/accounts/journal', label: 'Journal', perm: 'accounts:read' },
    { href: '/accounts/bank', label: 'Bank reconciliation', perm: 'accounts:read' },
    { href: '/gst', label: 'GST', perm: 'gst:read' },
  ] },
  { group: 'HR', items: [
    { href: '/dashboards/hr', label: 'HR dashboard', perm: 'hr:read' },
    { href: '/hr/pipeline', label: 'Hiring board', perm: 'hr:read' },
    { href: '/hr/applicants', label: 'Applicants', perm: 'hr:read' },
    { href: '/hr/openings', label: 'Openings', perm: 'hr:read' },
    { href: '/hr/employees', label: 'Employees', perm: 'hr:read' },
    { href: '/hr/attendance', label: 'Attendance', perm: 'hr:read' },
  ] },
  { group: 'Operations', items: [
    { href: '/dashboards/ops', label: 'Operations dashboard', perm: 'ops:read' },
    { href: '/ops/projects', label: 'Projects', perm: 'ops:read' },
    { href: '/ops/resources', label: 'Resource allocation', perm: 'ops:read' },
    { href: '/ops/tasks', label: 'Tasks', perm: 'ops:read' },
    { href: '/ops/routines', label: 'Routines', perm: 'ops:read' },
    { href: '/ops/assets', label: 'Assets & maintenance', perm: 'ops:read' },
  ] },
  { group: 'Admin', items: [
    { href: '/admin', label: 'Setup', perm: 'settings:manage' },
    { href: '/admin/users', label: 'Users', perm: 'users:manage' },
  ] },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // api() sends the browser to /login on a 401, so a signed-out visitor never sees the shell.
  const { data, error } = useGet<Session>('/auth/me');
  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!data) return <div className="center muted">Loading…</div>;
  const can = (p?: string) => !p || data.permissions.includes(p);
  // Highlight the one entry that fits the page best: on /leads/pipeline that is "Pipeline", not "Leads" as well.
  const active = NAV.flatMap((g) => g.items).filter((i) => can(i.perm) && (pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <SessionContext.Provider value={data}>
      <div className="shell">
        <nav className="nav no-print">
          <Link href="/" className="brand">RadCore</Link>
          {NAV.map((g) => {
            const items = g.items.filter((i) => can(i.perm));
            if (items.length === 0) return null;
            return (
              <div key={g.group} style={{ display: 'contents' }}>
                <div className="group">{g.group}</div>
                {items.map((i) => (
                  <Link key={i.href} href={i.href} className={i.href === active ? 'active' : undefined}>
                    {i.label}
                  </Link>
                ))}
              </div>
            );
          })}
          <div className="who">
            <div>{data.user.name}</div>
            <div className="muted">{data.user.role}</div>
            <Link href="/account" style={{ padding: '4px 0' }}>My password</Link>
            <button type="button" onClick={async () => { await post('/auth/logout'); window.location.href = '/login'; }}>Sign out</button>
          </div>
        </nav>
        <main className="main">
          {data.sample_data ? <div className="sample-banner no-print">Review copy with sample data. Nothing here is real, and it will be cleared before the system goes live.</div> : null}
          {children}
        </main>
      </div>
    </SessionContext.Provider>
  );
}
