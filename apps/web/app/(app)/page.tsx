'use client';

import Link from 'next/link';
import { Flow, type FlowStep } from '@/components/charts';
import { Page, inr } from '@/components/ui';
import { useGet } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

const TILES: [string, string, string][] = [
  ['/walk-in', 'Walk-in', 'leads:write'],
  ['/quick-bill', 'Quick bill', 'quickbill:create'],
  ['/leads/pipeline', 'Pipeline', 'leads:read'],
  ['/sales/orders', 'Quotes & orders', 'sales:read'],
  ['/purchasing/receipts', 'Inward & QC', 'grn:write'],
  ['/stock', 'Stock', 'stock:read'],
  ['/payments', 'Payments', 'payments:read'],
  ['/dashboards/sales', 'Sales dashboard', 'dashboard:sales'],
  ['/dashboards/marketing', 'Marketing dashboard', 'dashboard:marketing'],
  ['/dashboards/accounts', 'Accounts dashboard', 'dashboard:accounts'],
  ['/hr/pipeline', 'Hiring board', 'hr:read'],
  ['/hr/attendance', 'Attendance', 'hr:read'],
  ['/dashboards/hr', 'HR dashboard', 'hr:read'],
  ['/ops/projects', 'Projects', 'ops:read'],
  ['/ops/resources', 'Resource allocation', 'ops:read'],
  ['/ops/tasks', 'Tasks', 'ops:read'],
  ['/ops/assets', 'Assets & maintenance', 'ops:read'],
  ['/dashboards/ops', 'Operations dashboard', 'ops:read'],
];

/**
 * Home: the business as a picture. Each box is a step in the flow with the number of things
 * waiting there right now; clicking it opens the list behind the number. People only see
 * the steps their role works on.
 */
export default function Home() {
  const { user } = useSession();
  const can = useCan();
  const { data } = useGet<{ data: any }>('/dashboards/overview');
  const o = data?.data;

  const sale: FlowStep[] = [];
  const purchase: FlowStep[] = [];
  const attention: FlowStep[] = [];
  if (o?.leads) {
    sale.push({ label: 'New leads', value: o.leads.fresh, note: 'not yet contacted', href: '/leads?stage=new' });
    sale.push({
      label: 'Leads in progress', value: o.leads.in_progress, href: '/leads/pipeline',
      note: o.leads.follow_ups_due ? `${o.leads.follow_ups_due} follow-ups due` : `${o.leads.converted_this_month} converted this month`,
      alert: o.leads.follow_ups_due > 0,
    });
  }
  if (o?.orders) {
    sale.push({ label: 'Quotes', value: o.orders.quotes, note: 'waiting to be confirmed', href: '/sales/orders' });
    sale.push({ label: 'Orders to deliver', value: o.orders.to_deliver, href: '/sales/orders' });
    sale.push({ label: 'Delivered, to invoice', value: o.orders.to_invoice, href: '/sales/orders', alert: o.orders.to_invoice > 0 });
  }
  if (o?.invoices) {
    sale.push({ label: 'Unpaid invoices', value: o.invoices.unpaid, note: o.invoices.outstanding ? `₹${inr(o.invoices.outstanding)} to collect` : undefined, href: '/invoices' });
  }
  if (o?.purchasing) {
    purchase.push({ label: 'Orders with suppliers', value: o.purchasing.awaiting_goods, note: 'goods not yet in', href: '/purchasing/orders' });
    purchase.push({ label: 'Waiting for QC', value: o.purchasing.waiting_qc, note: 'received, not in stock', href: '/purchasing/receipts', alert: o.purchasing.waiting_qc > 0 });
    purchase.push({ label: 'Rejects to return', value: o.purchasing.rejects_to_return, href: '/purchasing/receipts', alert: o.purchasing.rejects_to_return > 0 });
    purchase.push({
      label: 'Bills to pay', value: o.purchasing.bills_unpaid, href: '/purchasing/bills',
      note: o.purchasing.bills_outstanding ? `₹${inr(o.purchasing.bills_outstanding)} owed` : undefined,
    });
  }
  if (o?.stock) {
    attention.push({ label: 'Items low on stock', value: o.stock.low_stock, href: '/stock', alert: o.stock.low_stock > 0 });
    if (can('stock:approve') || can('stock:write')) {
      attention.push({ label: 'Stock changes to approve', value: o.stock.adjustments_pending, href: '/stock', alert: o.stock.adjustments_pending > 0 });
    }
  }
  if (o?.bank) attention.push({ label: 'Bank lines to reconcile', value: o.bank.unreconciled, href: '/accounts/bank', alert: o.bank.unreconciled > 0 });
  if (o?.ops) {
    attention.push({ label: 'Late tasks, everyone', value: o.ops.tasks_overdue, note: `${o.ops.tasks_open_today} still open today`, href: '/ops/tasks?view=overdue', alert: o.ops.tasks_overdue > 0 });
    attention.push({ label: 'Maintenance due', value: o.ops.maintenance_due, href: '/ops/assets', alert: o.ops.maintenance_due > 0 });
  }

  const hiring: FlowStep[] = [];
  if (o?.hiring) {
    hiring.push({ label: 'New applications', value: o.hiring.applied, note: 'to be screened', href: '/hr/applicants?stage=applied' });
    hiring.push({ label: 'Shortlisted', value: o.hiring.shortlisted, href: '/hr/applicants?stage=shortlisted' });
    hiring.push({ label: 'In interviews', value: o.hiring.interview, href: '/hr/applicants?stage=interview' });
    hiring.push({ label: 'Offer made', value: o.hiring.offered, href: '/hr/applicants?stage=offered' });
    hiring.push({ label: 'Hired this month', value: o.hiring.hired_this_month, note: `${o.hiring.open_positions} open positions`, href: '/hr/applicants?stage=hired' });
  }

  // What is sitting with the person signed in. Shown to everyone, first.
  const mine: FlowStep[] = [];
  if (o?.mine) {
    mine.push({ label: 'My tasks today', value: o.mine.tasks_today, href: '/my-work' });
    mine.push({ label: 'My late tasks', value: o.mine.tasks_overdue, href: '/my-work', alert: o.mine.tasks_overdue > 0 });
    if (o.mine.maintenance_due > 0) mine.push({ label: 'Maintenance I look after', value: o.mine.maintenance_due, note: 'due now or soon', href: '/my-work', alert: true });
    if (o.mine.interviews > 0) mine.push({ label: 'Interviews to take', value: o.mine.interviews, href: '/my-work' });
  }

  return (
    <Page title={`Hello, ${user.name}`}>
      <Flow title="With me" steps={mine} arrows={false} />
      <Flow title="From enquiry to money in" steps={sale} />
      <Flow title="From purchase order to stock" steps={purchase} />
      <Flow title="From application to joining" steps={hiring} />
      <Flow title="Needs attention" steps={attention} arrows={false} />
      {/* Store screens are at most two taps away (PRD section 9). */}
      <div className="home-tiles">
        {TILES.filter(([, , perm]) => can(perm)).map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
      </div>
    </Page>
  );
}
