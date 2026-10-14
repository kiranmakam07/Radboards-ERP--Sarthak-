'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LeadAlerts } from '@/components/crm';
import { Icon } from '@/components/icons';
import { InstallButton } from '@/components/install';
import { ThemeButton } from '@/components/theme';
import { api, post, qs, useGet } from '@/lib/api';
import { SessionContext, type Session } from '@/lib/session';

/**
 * The signed-in area: everything under app/(app) is drawn inside this frame.
 *
 * NAV is the whole menu. Each entry names the permission that shows it (the same names the API
 * uses, from packages/shared/src/constants.ts); an entry with no permission is shown to everyone.
 * To add a screen: make app/(app)/<address>/page.tsx and add a line here. Hiding an entry is a
 * convenience only: the API refuses the request anyway if the person may not make it.
 */
type NavItem = { href: string; label: string; perm?: string };
const NAV: { group: string; icon: string; items: NavItem[] }[] = [
  { group: 'Me', icon: 'me', items: [
    { href: '/my-work', label: 'My work' },
    { href: '/dashboards/owner', label: "Owner's summary", perm: 'dashboard:owner' },
  ] },
  { group: 'Store', icon: 'store', items: [
    { href: '/walk-in', label: 'Walk-in', perm: 'leads:write' },
    { href: '/quick-bill', label: 'Quick bill', perm: 'quickbill:create' },
  ] },
  { group: 'CRM', icon: 'crm', items: [
    { href: '/leads/pipeline', label: 'Pipeline', perm: 'leads:read' },
    { href: '/leads', label: 'Leads', perm: 'leads:read' },
    { href: '/crm/sources', label: 'Lead sources', perm: 'crm:manage' },
    { href: '/campaigns', label: 'Campaign links', perm: 'leads:write' },
    { href: '/crm/replies', label: 'Quick replies', perm: 'leads:read' },
    { href: '/crm/plans', label: 'Follow-up plans', perm: 'leads:read' },
    { href: '/crm/spend', label: 'Ad spend', perm: 'crm:manage' },
    { href: '/dashboards/marketing', label: 'Marketing dashboard', perm: 'dashboard:marketing' },
  ] },
  { group: 'Sales', icon: 'sales', items: [
    { href: '/dashboards/sales', label: 'Sales dashboard', perm: 'dashboard:sales' },
    { href: '/sales/orders', label: 'Quotes & orders', perm: 'sales:read' },
    { href: '/sales/online', label: 'Online orders', perm: 'sales:read' },
    { href: '/invoices', label: 'Invoices', perm: 'invoices:read' },
    { href: '/parties', label: 'Parties', perm: 'parties:read' },
  ] },
  { group: 'Stores', icon: 'stores', items: [
    { href: '/dashboards/stores', label: 'Stores dashboard', perm: 'dashboard:stores' },
    { href: '/purchasing/orders', label: 'Purchase orders', perm: 'purchasing:read' },
    { href: '/purchasing/receipts', label: 'Inward & QC', perm: 'purchasing:read' },
    { href: '/stock', label: 'Stock', perm: 'stock:read' },
    { href: '/jobwork', label: 'Job work', perm: 'jobwork:read' },
    { href: '/items', label: 'Items', perm: 'items:read' },
  ] },
  { group: 'Accounts', icon: 'accounts', items: [
    { href: '/dashboards/accounts', label: 'Accounts dashboard', perm: 'dashboard:accounts' },
    { href: '/purchasing/bills', label: 'Purchase bills', perm: 'purchasing:read' },
    { href: '/payments', label: 'Payments', perm: 'payments:read' },
    { href: '/payments/reminders', label: 'To collect', perm: 'payments:read' },
    { href: '/expenses', label: 'Expenses', perm: 'expenses:read' },
    { href: '/accounts/reports', label: 'Books & reports', perm: 'accounts:read' },
    { href: '/accounts/journal', label: 'Journal', perm: 'accounts:read' },
    { href: '/accounts/chart', label: 'Chart of accounts', perm: 'accounts:read' },
    { href: '/accounts/transfers', label: 'Cash & bank transfers', perm: 'accounts:read' },
    { href: '/accounts/bank', label: 'Bank reconciliation', perm: 'accounts:read' },
    { href: '/gst', label: 'GST', perm: 'gst:read' },
  ] },
  { group: 'HR', icon: 'hr', items: [
    { href: '/dashboards/hr', label: 'HR dashboard', perm: 'hr:read' },
    { href: '/hr/pipeline', label: 'Hiring board', perm: 'hr:read' },
    { href: '/hr/applicants', label: 'Applicants', perm: 'hr:read' },
    { href: '/hr/openings', label: 'Openings', perm: 'hr:read' },
    { href: '/hr/employees', label: 'Employees', perm: 'hr:read' },
    { href: '/hr/attendance', label: 'Attendance', perm: 'hr:read' },
    { href: '/hr/payroll', label: 'Payroll', perm: 'payroll:read' },
  ] },
  { group: 'Operations', icon: 'operations', items: [
    { href: '/dashboards/ops', label: 'Operations dashboard', perm: 'ops:read' },
    { href: '/ops/projects', label: 'Projects', perm: 'ops:read' },
    { href: '/ops/resources', label: 'Resource allocation', perm: 'ops:read' },
    { href: '/ops/tasks', label: 'Tasks', perm: 'ops:read' },
    { href: '/ops/routines', label: 'Routines', perm: 'ops:read' },
    { href: '/ops/assets', label: 'Assets & maintenance', perm: 'ops:read' },
  ] },
  { group: 'Admin', icon: 'admin', items: [
    { href: '/masters', label: 'Masters', perm: 'masters:manage' },
    { href: '/admin', label: 'Setup', perm: 'settings:manage' },
    { href: '/admin/users', label: 'Users', perm: 'users:manage' },
    { href: '/admin/permissions', label: 'Permissions', perm: 'settings:manage' },
    { href: '/admin/audit', label: 'Audit trail', perm: 'audit:read' },
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
  return <Shell data={data} can={can} active={active} here={here} activeGroup={activeGroup} home={pathname === '/'} menuOpen={menuOpen} setMenuOpen={setMenuOpen}>{children}</Shell>;
}

/**
 * The frame around every screen: the menu on the left (its sections open one at a time, and the
 * section of the current screen opens by itself), and along the top of the panel where you are,
 * search, what is waiting for you, and your own menu.
 */
function Shell({ data, can, active, here, activeGroup, home, menuOpen, setMenuOpen, children }: {
  data: Session; can: (p?: string) => boolean; active: string | undefined; here: string | undefined; activeGroup: string | null; home: boolean;
  menuOpen: boolean; setMenuOpen: (open: boolean) => void; children: ReactNode;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroup);
  useEffect(() => { if (activeGroup) setOpenGroup(activeGroup); }, [activeGroup]);
  const close = () => setMenuOpen(false);

  return (
    <SessionContext.Provider value={data}>
      <div className={menuOpen ? 'shell menu-open' : 'shell'}>
        <button type="button" className="nav-backdrop no-print" aria-label="Close the menu" tabIndex={menuOpen ? 0 : -1} onClick={close} />
        <nav className="nav no-print" id="main-menu" aria-label="Main menu">
          <Link href="/" className="brand" onClick={close}><span className="brand-mark">R</span>RadCore</Link>
          <Link href="/" className={home ? 'top current' : 'top'} onClick={close}><Icon name="home" />Home</Link>
          <div className="divider" />
          {NAV.map((g) => {
            const items = g.items.filter((i) => can(i.perm));
            if (items.length === 0) return null;
            const open = openGroup === g.group;
            const panel = `menu-${g.group.toLowerCase()}`;
            return (
              <div key={g.group} className={open ? 'section open' : 'section'}>
                <button type="button" className={g.group === activeGroup ? 'group current' : 'group'} aria-expanded={open} aria-controls={panel}
                  onClick={() => setOpenGroup(open ? null : g.group)}>
                  <Icon name={g.icon} /><span>{g.group}</span><Icon name="down" size={16} className="chevron" />
                </button>
                <div id={panel} className="sub" hidden={!open}>
                  {items.map((i) => (
                    <Link key={i.href} href={i.href} className={i.href === active ? 'active' : undefined} onClick={close}
                      aria-current={i.href === active ? 'page' : undefined}>
                      <Icon name={i.href === active ? 'right' : 'dot'} size={14} />{i.label}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <main className="main">
          <header className="topbar no-print">
            <button type="button" className="icon-button menu-button" aria-label="Open the menu" aria-expanded={menuOpen} aria-controls="main-menu"
              onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" size={22} /></button>
            <div className="crumbs">
              {here ? <><span className="from">{activeGroup}</span><Icon name="right" size={14} className="sep" /><strong>{here}</strong></> : <strong>{home ? 'Home' : 'RadCore'}</strong>}
            </div>
            <Search can={can} />
            <Waiting />
            <MeMenu data={data} />
          </header>
          {data.sample_data ? <div className="sample-banner no-print">Review copy with sample data. Nothing here is real, and it will be cleared before the system goes live.</div> : null}
          {children}
          {can('leads:read') ? <LeadAlerts /> : null}
        </main>
      </div>
    </SessionContext.Provider>
  );
}

type Hit = { href: string; label: string; note?: string };

/**
 * Find a screen by its name, or a lead, customer, item or invoice by what is typed. Only what the
 * person may open is searched. Enter opens the first match; arrow keys move between them.
 */
function Search({ can }: { can: (p?: string) => boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<{ title: string; hits: Hit[] }[]>([]);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setGroups([]); return; }
    const words = term.toLowerCase();
    const screens: Hit[] = NAV.flatMap((g) => g.items.filter((i) => can(i.perm) && `${g.group} ${i.label}`.toLowerCase().includes(words))
      .map((i) => ({ href: i.href, label: i.label, note: g.group }))).slice(0, 6);
    setGroups(screens.length ? [{ title: 'Screens', hits: screens }] : []);
    setAt(0);
    let stale = false;
    const timer = setTimeout(async () => {
      const look = async (perm: string, title: string, path: string, map: (r: any) => Hit) => {
        if (!can(perm)) return null;
        try {
          const rows = (await api<{ data: any[] }>(`${path}${qs({ q: term, limit: 5 })}`)).data;
          return rows.length ? { title, hits: rows.map(map) } : null;
        } catch {
          return null;
        }
      };
      const found = await Promise.all([
        look('leads:read', 'Leads', '/leads', (r) => ({ href: `/leads/${r.id}`, label: r.name, note: `${r.lead_no} · ${r.stage}` })),
        look('parties:read', 'Customers and suppliers', '/parties', (r) => ({ href: `/parties/${r.id}`, label: r.name, note: r.party_type })),
        look('items:read', 'Items', '/items', (r) => ({ href: `/items/${r.id}`, label: r.name, note: r.sku })),
        look('invoices:read', 'Invoices', '/sales/invoices', (r) => ({ href: `/invoices/${r.id}`, label: r.invoice_no ?? 'Draft', note: r.party_name })),
      ]);
      if (!stale) setGroups((g) => [...g.filter((x) => x.title === 'Screens'), ...found.filter((x): x is { title: string; hits: Hit[] } => Boolean(x))]);
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [q, can]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const flat = groups.flatMap((g) => g.hits);
  const go = (hit: Hit | undefined) => {
    if (!hit) return;
    setOpen(false);
    setQ('');
    router.push(hit.href);
  };

  return (
    <div className="search" ref={box}>
      <input type="search" placeholder="Search…" value={q} aria-label="Search screens, leads, customers, items and invoices"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, flat.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') go(flat[at]);
          if (e.key === 'Escape') setOpen(false);
        }} />
      <Icon name="search" size={17} />
      {open && q.trim().length >= 2 && (
        <div className="search-results" role="listbox">
          {flat.length === 0 ? <p className="muted small" style={{ margin: 8 }}>Nothing found for “{q.trim()}”.</p> : groups.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.hits.map((h) => (
                <Link key={h.href} href={h.href} className={flat[at] === h ? 'on' : undefined} onClick={(e) => { e.preventDefault(); go(h); }}>
                  <span>{h.label}</span>{h.note ? <span className="muted">{h.note}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The bell: how many things are sitting with the person signed in (new leads, follow-ups due, tasks). */
function Waiting() {
  const { data } = useGet<{ data: any }>('/dashboards/overview');
  const o = data?.data;
  const n = (o?.my_leads?.fresh ?? 0) + (o?.my_leads?.follow_ups_due ?? 0) + (o?.mine?.tasks_today ?? 0) + (o?.mine?.tasks_overdue ?? 0);
  return (
    <Link href="/my-work" className="icon-button" aria-label={n ? `${n} things waiting for you` : 'My work'} title={n ? `${n} waiting for you` : 'My work'}>
      <Icon name="bell" size={20} />{n ? <span className="count-dot">{n > 99 ? '99+' : n}</span> : null}
    </Link>
  );
}

function MeMenu({ data }: { data: Session }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  const initials = data.user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return (
    <div className="me" ref={box}>
      <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`${data.user.name}: your menu`} onClick={() => setOpen(!open)}>
        {initials || 'R'}
      </button>
      {open && (
        <div className="me-menu" role="menu">
          <div className="who"><div>{data.user.name}</div><div className="role">{data.user.role}</div></div>
          <Link href="/account" role="menuitem" onClick={() => setOpen(false)}><Icon name="key" />My password</Link>
          <ThemeButton />
          <InstallButton className="install" />
          <button type="button" role="menuitem" onClick={async () => { await post('/auth/logout'); window.location.href = '/login'; }}><Icon name="logout" />Sign out</button>
        </div>
      )}
    </div>
  );
}
