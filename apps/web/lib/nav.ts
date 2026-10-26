/**
 * The whole menu, shown down the side of every screen (app/(app)/layout.tsx) and as section tiles
 * on the home screen. Each entry names the permission that shows it (the same names the API uses,
 * from packages/shared/src/constants.ts); an entry with no permission is shown to everyone.
 * To add a screen: make app/(app)/<address>/page.tsx and add a line here. Hiding an entry is a
 * convenience only: the API refuses the request anyway if the person may not make it.
 */
export type NavItem = { href: string; label: string; perm?: string };
export type NavSection = { group: string; icon: string; blurb: string; items: NavItem[] };

export const NAV: NavSection[] = [
  { group: 'Me', icon: 'me', blurb: 'Your tasks, attendance, leave and payslips', items: [
    { href: '/my-work', label: 'My work' },
    { href: '/dashboards/owner', label: "Owner's summary", perm: 'dashboard:owner' },
  ] },
  { group: 'Store', icon: 'store', blurb: 'Walk-ins and the counter bill', items: [
    { href: '/walk-in', label: 'Walk-in', perm: 'leads:write' },
    { href: '/quick-bill', label: 'Quick bill', perm: 'quickbill:create' },
  ] },
  { group: 'CRM', icon: 'crm', blurb: 'Leads, the pipeline and follow-ups', items: [
    { href: '/leads/pipeline', label: 'Pipeline', perm: 'leads:read' },
    { href: '/leads', label: 'Leads', perm: 'leads:read' },
    { href: '/leads/test-rides', label: 'Test rides', perm: 'leads:read' },
    { href: '/crm/sources', label: 'Lead sources', perm: 'crm:manage' },
    { href: '/campaigns', label: 'Campaign links', perm: 'leads:write' },
    { href: '/crm/replies', label: 'Quick replies', perm: 'leads:read' },
    { href: '/crm/plans', label: 'Follow-up plans', perm: 'leads:read' },
    { href: '/crm/spend', label: 'Ad spend', perm: 'crm:manage' },
    { href: '/dashboards/marketing', label: 'Marketing dashboard', perm: 'dashboard:marketing' },
  ] },
  { group: 'Sales', icon: 'sales', blurb: 'Quotes, orders, invoices and customers', items: [
    { href: '/dashboards/sales', label: 'Sales dashboard', perm: 'dashboard:sales' },
    { href: '/sales/orders', label: 'Quotes & orders', perm: 'sales:read' },
    { href: '/sales/online', label: 'Online orders', perm: 'sales:read' },
    { href: '/invoices', label: 'Invoices', perm: 'invoices:read' },
    { href: '/parties', label: 'Parties', perm: 'parties:read' },
  ] },
  { group: 'Stores', icon: 'stores', blurb: 'Products, stock, purchasing and job work', items: [
    { href: '/dashboards/stores', label: 'Stores dashboard', perm: 'dashboard:stores' },
    { href: '/purchasing/orders', label: 'Purchase orders', perm: 'purchasing:read' },
    { href: '/purchasing/receipts', label: 'Inward & QC', perm: 'purchasing:read' },
    { href: '/stock', label: 'Stock', perm: 'stock:read' },
    { href: '/units', label: 'Units by serial', perm: 'units:read' },
    { href: '/imports', label: 'Imports & landed cost', perm: 'imports:read' },
    { href: '/jobwork', label: 'Job work', perm: 'jobwork:read' },
    { href: '/items', label: 'Products', perm: 'items:read' },
  ] },
  { group: 'Accounts', icon: 'accounts', blurb: 'Payments, expenses, books and GST', items: [
    { href: '/dashboards/accounts', label: 'Accounts dashboard', perm: 'dashboard:accounts' },
    { href: '/purchasing/bills', label: 'Purchase bills', perm: 'purchasing:read' },
    { href: '/payments', label: 'Payments', perm: 'payments:read' },
    { href: '/payments/reminders', label: 'To collect', perm: 'payments:read' },
    { href: '/imports/advances', label: 'Advances to suppliers', perm: 'payments:read' },
    { href: '/expenses', label: 'Expenses', perm: 'expenses:read' },
    { href: '/accounts/reports', label: 'Books & reports', perm: 'accounts:read' },
    { href: '/accounts/journal', label: 'Journal', perm: 'accounts:read' },
    { href: '/accounts/chart', label: 'Chart of accounts', perm: 'accounts:read' },
    { href: '/accounts/transfers', label: 'Cash & bank transfers', perm: 'accounts:read' },
    { href: '/accounts/bank', label: 'Bank reconciliation', perm: 'accounts:read' },
    { href: '/gst', label: 'GST', perm: 'gst:read' },
  ] },
  { group: 'HR', icon: 'hr', blurb: 'Hiring, employees, attendance and payroll', items: [
    { href: '/dashboards/hr', label: 'HR dashboard', perm: 'hr:read' },
    { href: '/hr/pipeline', label: 'Hiring board', perm: 'hr:read' },
    { href: '/hr/applicants', label: 'Applicants', perm: 'hr:read' },
    { href: '/hr/openings', label: 'Openings', perm: 'hr:read' },
    { href: '/hr/employees', label: 'Employees', perm: 'hr:read' },
    { href: '/hr/attendance', label: 'Attendance', perm: 'hr:read' },
    { href: '/hr/payroll', label: 'Payroll', perm: 'payroll:read' },
  ] },
  { group: 'Service', icon: 'service', blurb: 'Job cards, warranty and supplier claims', items: [
    { href: '/service', label: 'Job cards', perm: 'service:read' },
    { href: '/service/claims', label: 'Supplier claims', perm: 'service:read' },
    { href: '/service/reports', label: 'Service reports', perm: 'service:read' },
    { href: '/service/setup', label: 'Warranty & fault codes', perm: 'service:read' },
  ] },
  { group: 'Operations', icon: 'operations', blurb: 'Projects, tasks, routines and assets', items: [
    { href: '/dashboards/ops', label: 'Operations dashboard', perm: 'ops:read' },
    { href: '/ops/projects', label: 'Projects', perm: 'ops:read' },
    { href: '/ops/resources', label: 'Resource allocation', perm: 'ops:read' },
    { href: '/ops/tasks', label: 'Tasks', perm: 'ops:read' },
    { href: '/ops/routines', label: 'Routines', perm: 'ops:read' },
    { href: '/ops/assets', label: 'Assets & maintenance', perm: 'ops:read' },
  ] },
  { group: 'Admin', icon: 'admin', blurb: 'Masters, users and settings', items: [
    { href: '/masters', label: 'Masters', perm: 'masters:manage' },
    { href: '/admin', label: 'Setup', perm: 'settings:manage' },
    { href: '/admin/opening', label: 'Moving from Vyapar', perm: 'opening:import' },
    { href: '/admin/users', label: 'Users', perm: 'users:manage' },
    { href: '/admin/permissions', label: 'Permissions', perm: 'settings:manage' },
    { href: '/admin/audit', label: 'Audit trail', perm: 'audit:read' },
  ] },
];
