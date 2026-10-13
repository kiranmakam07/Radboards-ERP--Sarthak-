'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LeadAlerts } from '@/components/crm';
import { InstallButton } from '@/components/install';
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
    { href: '/crm/plans', label: 'Follow-up plans', perm: 'leads:read' },
    { href: '/crm/spend', label: 'Ad spend', perm: 'crm:manage' },
    { href: '/dashboards/marketing', label: 'Marketing dashboard', perm: 'dashboard:marketing' },
  ] },
  { group: 'Sales', items: [
    { href: '/dashboards/sales', label: 'Sales dashboard', perm: 'dashboard:sales' },
    { href: '/sales/orders', label: 'Quotes & orders', perm: 'sales:read' },
    { href: '/sales/online', label: 'Online orders', perm: 'sales:read' },
    { href: '/invoices', label: 'Invoices', perm: 'invoices:read' },
    { href: '/parties', label: 'Parties', perm: 'parties:read' },
  ] },
  { group: 'Stores', items: [
    { href: '/dashboards/stores', label: 'Stores dashboard', perm: 'dashboard:stores' },
    { href: '/purchasing/orders', label: 'Purchase orders', perm: 'purchasing:read' },
    { href: '/purchasing/receipts', label: 'Inward & QC', perm: 'purchasing:read' },
    { href: '/stock', label: 'Stock', perm: 'stock:read' },
    { href: '/jobwork', label: 'Job work', perm: 'jobwork:read' },
    { href: '/items', label: 'Items', perm: 'items:read' },
  ] },
  { group: 'Accounts', items: [
    { href: '/dashboards/accounts', label: 'Accounts dashboard', perm: 'dashboard:accounts' },
    { href: '/purchasing/bills', label: 'Purchase bills', perm: 'purchasing:read' },
    { href: '/payments', label: 'Payments', perm: 'payments:read' },
    { href: '/payments/reminders', label: 'To collect', perm: 'payments:read' },
    { href: '/expenses', label: 'Expenses', perm: 'expenses:read' },
    { href: '/accounts/reports', label: 'Books & reports', perm: 'accounts:read' },
    { href: '/accounts/journal', label: 'Journal', perm: 'accounts:read' },
    { href: '/accounts/transfers', label: 'Cash & bank transfers', perm: 'accounts:read' },
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
    { href: '/hr/payroll', label: 'Payroll', perm: 'payroll:read' },
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
    { href: '/masters', label: 'Masters', perm: 'masters:manage' },
    { href: '/admin', label: 'Setup', perm: 'settings:manage' },
    { href: '/admin/users', label: 'Users', perm: 'users:manage' },
    { href: '/admin/permissions', label: 'Permissions', perm: 'settings:manage' },
  ] },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // On a phone the menu is a panel that slides in from the side; on a wide screen it is always there.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  // api() sends the browser to /login on a 401, so a signed-out visitor never sees the shell.
  const { data, error } = useGet<Session>('/auth/me');
  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!data) return <div className="center muted">Loading…</div>;
  const can = (p?: string) => !p || data.permissions.includes(p);
  // Highlight the one entry that fits the page best: on /leads/pipeline that is "Pipeline", not "Leads" as well.
  const active = NAV.flatMap((g) => g.items).filter((i) => can(i.perm) && (pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const here = NAV.flatMap((g) => g.items).find((i) => i.href === active)?.label;
  const activeGroup = NAV.find((g) => g.items.some((i) => i.href === active))?.group ?? null;
  return <Shell data={data} can={can} active={active} here={here} activeGroup={activeGroup} menuOpen={menuOpen} setMenuOpen={setMenuOpen}>{children}</Shell>;
}

/**
 * The frame around every screen. The menu is a list of sections that open one at a time:
 * opening one closes the one that was open, and the section of the current screen opens by itself.
 */
function Shell({ data, can, active, here, activeGroup, menuOpen, setMenuOpen, children }: {
  data: Session; can: (p?: string) => boolean; active: string | undefined; here: string | undefined; activeGroup: string | null;
  menuOpen: boolean; setMenuOpen: (open: boolean) => void; children: ReactNode;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroup);
  useEffect(() => { if (activeGroup) setOpenGroup(activeGroup); }, [activeGroup]);

  return (
    <SessionContext.Provider value={data}>
      <div className={menuOpen ? 'shell menu-open' : 'shell'}>
        <header className="topbar no-print">
          <button type="button" className="menu-button" aria-expanded={menuOpen} aria-controls="main-menu" onClick={() => setMenuOpen(!menuOpen)}>
            <span aria-hidden="true">☰</span> Menu
          </button>
          <Link href="/" className="brand">RadCore</Link>
          {here ? <span className="here">{here}</span> : null}
        </header>
        <button type="button" className="nav-backdrop no-print" aria-label="Close the menu" tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)} />
        <nav className="nav no-print" id="main-menu">
          <Link href="/" className="brand" onClick={() => setMenuOpen(false)}>RadCore</Link>
          {NAV.map((g) => {
            const items = g.items.filter((i) => can(i.perm));
            if (items.length === 0) return null;
            const open = openGroup === g.group;
            const panel = `menu-${g.group.toLowerCase()}`;
            return (
              <div key={g.group} className={open ? 'section open' : 'section'}>
                <button type="button" className={g.group === activeGroup ? 'group current' : 'group'} aria-expanded={open} aria-controls={panel}
                  onClick={() => setOpenGroup(open ? null : g.group)}>
                  <span>{g.group}</span><span className="chevron" aria-hidden="true">▾</span>
                </button>
                <div id={panel} hidden={!open}>
                  {items.map((i) => (
                    <Link key={i.href} href={i.href} className={i.href === active ? 'active' : undefined} onClick={() => setMenuOpen(false)}>
                      {i.label}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="who">
            <InstallButton className="install" />
            <div>{data.user.name}</div>
            <div className="muted">{data.user.role}</div>
            <Link href="/account" style={{ padding: '4px 0' }}>My password</Link>
            <button type="button" onClick={async () => { await post('/auth/logout'); window.location.href = '/login'; }}>Sign out</button>
          </div>
        </nav>
        <main className="main">
          {data.sample_data ? <div className="sample-banner no-print">Review copy with sample data. Nothing here is real, and it will be cleared before the system goes live.</div> : null}
          {children}
          {can('leads:read') ? <LeadAlerts /> : null}
        </main>
      </div>
    </SessionContext.Provider>
  );
}
